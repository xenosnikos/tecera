import { randomUUID } from 'node:crypto';
import { LedgerError, makeRedactor, sha256, type EventKind, type Json, type Ledger, type Redactor, type SecretInput } from '@tecera/contracts';
import { ignoredPathKey, type IgnoredBaseline } from './candidate.js';

/**
 * Where gate evidence is found again, and how it is written. The gates never emit loop events (the loop
 * records verify.*, review.* and commit.recorded with our evidenceKey); they write evidence and remember
 * the last key per intention in-process. After a restart the memo is empty, so lookups fall back to the
 * loop's events on the ledger, then to the evidence body. A body without the expected shape is absent.
 *
 * Every evidence body goes through the shared redactor (contracts makeRedactor) right before the write:
 * strings (and object keys) are redacted whole, and only then truncated by the caller's caps. There is no
 * raw ledger.evidence call in the gates: claims and the ignored baseline go through writeEvidence too.
 * Anything a restart must match again (baseline paths, per-file records, the verify command) is also
 * stored as a digest, so redaction never changes what a lookup compares.
 */

export interface VerifyMemo {
  evidenceKey: string;
  fingerprint: string;
  outcome: string;
  files: Json | undefined;
  /** sha256 of the check command that ran (commandDigest); absent on evidence that predates it. */
  commandDigest?: string;
}

export interface ReviewMemo {
  evidenceKey: string;
  d1: string;
  d2: string;
  verdict: 'approve' | 'reject';
  files: Json | undefined;
}

export class GateMemo {
  readonly verify = new Map<string, VerifyMemo>();
  readonly review = new Map<string, ReviewMemo>();
  /** Ignored-file baseline per run (path key → ignoredStamp, path key → redacted name), recorded by the baseline verify. */
  readonly ignoredBaseline = new Map<string, IgnoredBaseline>();
}

export function redactorFrom(o: { redactor?: Redactor; secrets?: readonly SecretInput[] }): Redactor {
  return o.redactor ?? makeRedactor(o.secrets ?? []);
}

/** Keep the last `cap` characters of an already-redacted text. */
export function tail(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `[...${text.length - cap} chars elided...]\n` + text.slice(text.length - cap);
}

/** Redact the whole body (decoded values, before any truncation of the stored form) and write it. */
export async function writeEvidence(ledger: Ledger, redactor: Redactor, e: { key: string; kind: string; runId: string; body: Json }) {
  return ledger.evidence({ key: e.key, kind: e.kind, runId: e.runId, body: redactor.redactJson(e.body) });
}

/** Digest of a check command as recorded in verify evidence (the command text itself may be redacted). */
export function commandDigest(command: string): string {
  return sha256(`tecera.verify.command\0${command}`);
}

/**
 * Atomic create-if-absent claim. The body carries a fresh nonce, so two claimants never write identical
 * bodies: the ledger accepts exactly one and refuses the other with LedgerError('evidence'). Returns true
 * for the sole winner, false for a loser; other ledger failures propagate (fail closed). The body is
 * redacted like every other evidence body (the nonce is a UUID, which redaction leaves unchanged).
 */
export async function claim(ledger: Ledger, redactor: Redactor, key: string, kind: string, runId: string, body: Record<string, Json>): Promise<{ won: boolean; nonce: string }> {
  const nonce = randomUUID();
  try {
    const rec = await writeEvidence(ledger, redactor, { key, kind, runId, body: { ...body, claimNonce: nonce } });
    const got = rec.body && typeof rec.body === 'object' && !Array.isArray(rec.body) ? (rec.body as Record<string, Json>).claimNonce : undefined;
    return { won: got === nonce, nonce };
  } catch (err) {
    if (err instanceof LedgerError && err.code === 'evidence') return { won: false, nonce };
    throw err;
  }
}

async function lastEvidenceKey(ledger: Ledger, runId: string, intentionId: string, kinds: EventKind[]): Promise<string | null> {
  let key: string | null = null;
  for await (const e of ledger.events({ runId, kinds })) {
    if (e.trace.intentionId !== intentionId) continue;
    const k = (e.payload as { evidenceKey?: unknown }).evidenceKey;
    if (typeof k === 'string') key = k;
  }
  return key;
}

export function obj(body: Json | undefined): Record<string, Json> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, Json>) : null;
}

export function verifyMemoFrom(key: string, body: Json): VerifyMemo | null {
  const b = obj(body);
  if (!b || typeof b.fingerprint !== 'string' || typeof b.outcome !== 'string') return null;
  return { evidenceKey: key, fingerprint: b.fingerprint, outcome: b.outcome, files: b.files, ...(typeof b.commandDigest === 'string' ? { commandDigest: b.commandDigest } : {}) };
}

export function reviewMemoFrom(key: string, body: Json): ReviewMemo | null {
  const b = obj(body);
  if (!b || typeof b.fingerprintBefore !== 'string' || typeof b.fingerprintAfter !== 'string') return null;
  if (b.verdict !== 'approve' && b.verdict !== 'reject') return null;
  return { evidenceKey: key, d1: b.fingerprintBefore, d2: b.fingerprintAfter, verdict: b.verdict, files: b.files };
}

export async function latestVerify(ledger: Ledger, memo: GateMemo, runId: string, intentionId: string): Promise<VerifyMemo | null> {
  const m = memo.verify.get(`${runId}:${intentionId}`);
  if (m) return m;
  const key = await lastEvidenceKey(ledger, runId, intentionId, ['verify.passed', 'verify.failed']);
  if (!key) return null;
  const rec = await ledger.getEvidence(key);
  return rec ? verifyMemoFrom(key, rec.body) : null;
}

export async function latestReview(ledger: Ledger, memo: GateMemo, runId: string, intentionId: string): Promise<ReviewMemo | null> {
  const m = memo.review.get(`${runId}:${intentionId}`);
  if (m) return m;
  const key = await lastEvidenceKey(ledger, runId, intentionId, ['review.passed', 'review.rejected']);
  if (!key) return null;
  const rec = await ledger.getEvidence(key);
  return rec ? reviewMemoFrom(key, rec.body) : null;
}

export const ignoredBaselineKey = (runId: string) => `verify-baseline-ignored:${runId}`;

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Build the persisted form of an ignored baseline from a snapshot's present ignored files (path → stamp):
 * entries keyed by ignoredPathKey, display names redacted. The memo holds exactly what is persisted, so a
 * fresh process reading the ledger sees the same baseline (and the same names) as the one that wrote it.
 */
export function ignoredBaselineOf(ignored: Readonly<Record<string, string>>, redactor: Redactor): IgnoredBaseline {
  const entries: Record<string, string> = {};
  const names: Record<string, string> = {};
  for (const p of Object.keys(ignored).sort()) {
    const k = ignoredPathKey(p);
    entries[k] = ignored[p]!;
    names[k] = redactor.redactText(p);
  }
  return { entries, names };
}

/** Persisted ignored-baseline body version: entries hold ignoredStamp values (content + type + mode + links). */
export const IGNORED_BASELINE_VERSION = 3;

/**
 * The run's ignored-file baseline, from memo or evidence. Absent = every ignored file is a change.
 * A malformed record is treated as absent (fail closed: nothing is excused). v3 entries are stamps.
 * Older records (v2 {entries: key → content sha256}, pre-v2 {files: path → sha256}) never attested type,
 * mode or link identity: they are read as `legacy:<sha>` entries, which match no stamp, so every file they
 * name is a change (refused at commit) while their deletion is still detected.
 */
export async function ignoredBaseline(ledger: Ledger, memo: GateMemo, runId: string): Promise<IgnoredBaseline | undefined> {
  const m = memo.ignoredBaseline.get(runId);
  if (m) return m;
  const b = obj((await ledger.getEvidence(ignoredBaselineKey(runId)))?.body);
  if (!b) return undefined;
  const entries: Record<string, string> = {};
  const names: Record<string, string> = {};
  const ent = obj(b.entries);
  if ((b.v === IGNORED_BASELINE_VERSION || b.v === 2) && ent) {
    const legacy = b.v !== IGNORED_BASELINE_VERSION;
    const nm = obj(b.names) ?? {};
    for (const [k, v] of Object.entries(ent)) {
      if (!HEX64.test(k) || typeof v !== 'string' || !HEX64.test(v)) return undefined;
      entries[k] = legacy ? `legacy:${v}` : v;
      if (typeof nm[k] === 'string') names[k] = nm[k] as string;
    }
  } else if (b.v === undefined || b.v === 1) {
    const files = obj(b.files);
    if (!files) return undefined;
    for (const [p, v] of Object.entries(files)) {
      if (typeof v !== 'string' || !HEX64.test(v)) return undefined;
      entries[ignoredPathKey(p)] = `legacy:${v}`;
      names[ignoredPathKey(p)] = p;
    }
  } else return undefined;
  const out: IgnoredBaseline = { entries, names };
  memo.ignoredBaseline.set(runId, out);
  return out;
}

export function defaultIds(): () => string {
  return () => randomUUID();
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A diagnostic string as it may leave a gate (result `reason`, fingerprint sentinels): redacted whole.
 * If the redactor itself fails, the text is withheld rather than returned raw (fail closed).
 */
export function safeText(redactor: Redactor, text: unknown): string {
  try {
    return redactor.redactText(typeof text === 'string' ? text : String(text));
  } catch {
    return '[diagnostic withheld: redaction failed]';
  }
}
