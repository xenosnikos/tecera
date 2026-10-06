import { z } from 'zod';
import { canonicalJson, sha256, stringLeaves, type Json } from './json.js';

/**
 * tecera.json v1. Unknown fields are rejected everywhere (`.strict()`), secrets are references only,
 * and a manifest missing any mandatory hook does not parse. See README.md §2.
 */

export const MANDATORY_HOOKS = [
  'budgetPool',
  'recursionLimit',
  'iterationLimit',
  'toolAllowlist',
  'protectedPaths',
  'diffBoundary',
  'approvalGate',
  'foreignReview',
  'verifyGate',
  'tamperCheck',
  'progressCheck',
  'secretCanary',
  'evidenceRecorder',
  'returnSchema',
] as const;
export type MandatoryHook = (typeof MANDATORY_HOOKS)[number];

/** Patterns that look like credentials. Any string leaf matching one of these fails validation. */
export const SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'anthropic', re: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { kind: 'openai', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/ },
  { kind: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { kind: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: 'canary', re: /TECERA_CANARY_[A-Za-z0-9_]+/ },
];

const SECRET_REF = /^(env:[A-Z_][A-Z0-9_]*|file:[^#\s]+(#[A-Za-z0-9_]+)?|keychain:[A-Za-z0-9_./-]+)$/;
const BLANKET_GLOBS = new Set(['*', '**', '**/*', '/**', './**']);
const SEMVER_RANGE = /^[\^~>=<\s\d.x*|-]+$/;

const seat = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    effort: z.enum(['low', 'medium', 'high']).default('medium'),
  })
  .strict();

/** Message for the removed 'off' value (D2): readable, so an old manifest says what to change. */
export const REFLEX_OFF_REMOVED =
  "reflex setting 'off' was removed: every seam always answers (use 'rule', 'model' or 'frontier'; the gate seam can never be disabled)";

const reflexSetting = z.enum(['rule', 'model', 'frontier'], {
  errorMap: (issue, ctx) => ({
    message: issue.code === 'invalid_enum_value' && issue.received === 'off' ? REFLEX_OFF_REMOVED : ctx.defaultError,
  }),
});

/** A seat's vendor: the prefix of an OpenRouter-style model id ('anthropic/claude-…'), else the provider key. */
export function seatVendor(s: { provider: string; model: string }): string {
  const slash = s.model.indexOf('/');
  return (slash > 0 ? s.model.slice(0, slash) : s.provider).toLowerCase();
}

export const ManifestSchema = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.literal(1),
    id: z.string().regex(/^bc_[a-z0-9]{6,}$/),
    name: z.string().min(1),
    owner: z.string().min(1),
    runtime: z.object({ tecera: z.string().regex(SEMVER_RANGE) }).strict(),
    repo: z
      .object({
        base: z.string().min(1),
        branchPrefix: z.string().min(1).default('tecera/'),
        allowedChanges: z.array(z.string().min(1)).refine((g) => g.every((x) => !BLANKET_GLOBS.has(x)), {
          message: 'allowedChanges may not contain a blanket glob (EEZE rule)',
        }),
      })
      .strict(),
    providers: z.record(
      z.string().min(1),
      z.object({ auth: z.string().regex(SECRET_REF, 'auth must be a secret reference (env:/file:/keychain:)') }).strict(),
    ),
    seats: z
      .object({
        planner: seat,
        workers: z.array(seat.extend({ id: z.string().min(1) }).strict()).min(1),
        reviewer: seat,
        reflex: z
          .object({ provider: z.enum(['rules', 'jev', 'openai-decisions', 'strands']).default('rules'), model: z.string().optional() })
          .strict()
          .default({ provider: 'rules' }),
      })
      .strict(),
    // Unset seams default to 'model' when a decision-model provider is configured (seats.reflex.provider
    // other than 'rules'), else 'rule' (resolved after parsing, see resolveReflexDefaults). Never 'off'.
    reflexes: z
      .object({
        triage: reflexSetting.optional(),
        choosePlan: reflexSetting.optional(),
        route: reflexSetting.optional(),
        gate: reflexSetting.optional(),
        reconsider: reflexSetting.optional(),
        closeOut: reflexSetting.optional(),
        threshold: z.number().min(0).max(1).default(0.6),
      })
      .strict()
      .default({}),
    commitment: z.enum(['blind', 'single-minded', 'open-minded']).default('single-minded'),
    concurrency: z.object({ perAgent: z.number().int().min(1).default(2) }).strict().default({}),
    budgets: z
      .object({
        usd: z.number().positive(),
        tokens: z.number().int().positive(),
        wallClockSec: z.number().int().positive(),
        maxDepth: z.number().int().min(1).max(8),
        maxIterations: z.number().int().min(1),
        maxAttempts: z.number().int().min(1).max(5),
        maxChangedFiles: z.number().int().min(1),
        /**
         * D3: when false (the default) the usd / tokens / calls / wall-clock pools are still opened, reserved,
         * settled and reported, but exhausting them does not end the run (budget.exhausted is recorded
         * instead). True makes exhaustion terminal (exit 7). maxDepth / maxIterations / maxAttempts and
         * per-exec timeouts are loop-safety limits, always enforced.
         */
        enforce: z.boolean().default(false),
      })
      .strict(),
    sandbox: z
      .object({
        profile: z.enum(['process', 'bwrap', 'docker']),
        isolation: z.enum(['os', 'node']),
        network: z.literal(false),
        memoryMb: z.number().int().min(64),
        execTimeoutSec: z.number().int().min(1),
        envAllowlist: z.array(z.string()).default(['PATH', 'HOME', 'CI']),
      })
      .strict(),
    policy: z
      .object({
        protectedPaths: z.array(z.string().min(1)),
        approvals: z
          .object({
            /** Actions that need a human approval. Default ['open_pr'] (D6: the PR gate is the approval point). */
            required: z.array(z.string().min(1)).default(['open_pr']),
            ttlSec: z.number().int().positive(),
            quorum: z.literal(1),
            separationOfDuty: z.literal(true),
          })
          .strict(),
        failure: z
          .object({
            onVerifyFail: z.enum(['retry-once', 'stop']),
            onReviewFail: z.enum(['retry-once', 'stop']),
            onLedgerError: z.literal('stop'),
          })
          .strict(),
      })
      .strict(),
    verify: z.object({ command: z.string().min(1), timeoutSec: z.number().int().positive() }).strict(),
    review: z
      .object({
        // D5: review is always foreign; false is refused (a same-vendor review is not a review).
        foreign: z.literal(true, { errorMap: () => ({ message: 'review.foreign must be true: every change is reviewed by a foreign provider (owner decision D5)' }) }),
        maxAttempts: z.number().int().min(1).max(3),
      })
      .strict(),
    board: z.object({ driver: z.enum(['ledger', 'jira', 'kanban']) }).strict().default({ driver: 'ledger' }),
    ledger: z
      .object({
        driver: z.enum(['sqlite', 'memory']),
        path: z.string().min(1),
        retentionDays: z.number().int().positive().default(90),
      })
      .strict()
      .default({ driver: 'sqlite', path: '.tecera/ledger.sqlite', retentionDays: 90 }),
    memory: z.object({ contextBudgetTokens: z.number().int().positive() }).strict().default({ contextBudgetTokens: 40000 }),
    hooks: z.object({ mandatory: z.array(z.string()) }).strict(),
    adapters: z.record(z.string(), z.object({ enabled: z.boolean() }).strict()).default({}),
  })
  .strict()
  .superRefine((m, ctx) => {
    const want = new Set<string>(MANDATORY_HOOKS);
    const have = new Set(m.hooks.mandatory);
    const missing = [...want].filter((h) => !have.has(h));
    const extra = [...have].filter((h) => !want.has(h));
    if (missing.length || extra.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hooks', 'mandatory'],
        message: `hooks.mandatory must equal MANDATORY_HOOKS (missing: ${missing.join(',') || '-'}; extra: ${extra.join(',') || '-'})`,
      });
    }
    for (const s of [m.seats.planner, m.seats.reviewer, ...m.seats.workers]) {
      if (!(s.provider in m.providers)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['seats'], message: `seat provider "${s.provider}" is not declared in providers` });
      }
    }
    // Foreign review (D5): another provider, another credential, another vendor than every worker seat.
    const reviewer = m.seats.reviewer;
    const writerProviders = new Set(m.seats.workers.map((w) => w.provider));
    if (writerProviders.has(reviewer.provider)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['seats', 'reviewer'], message: 'review.foreign requires the reviewer provider to differ from every worker provider' });
    } else {
      const reviewerAuth = m.providers[reviewer.provider]?.auth;
      if (reviewerAuth !== undefined && m.seats.workers.some((w) => m.providers[w.provider]?.auth === reviewerAuth)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['seats', 'reviewer'], message: 'review.foreign requires the reviewer to use another credential than every worker (same auth reference)' });
      }
      if (m.seats.workers.some((w) => seatVendor(w) === seatVendor(reviewer))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['seats', 'reviewer'], message: `review.foreign requires the reviewer vendor (${seatVendor(reviewer)}) to differ from every worker vendor` });
      }
    }
    if (m.policy.approvals.required.includes('commit')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['policy', 'approvals', 'required'],
        message: "'commit' no longer requires approval: commits go to the work branch and the PR gate is the approval point (owner decision D6); use 'open_pr'",
      });
    }
    if (m.sandbox.network !== false) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sandbox', 'network'], message: 'network must be false in v1' });
    }
  })
  .transform((m) => ({
    ...m,
    reflexes: resolveReflexDefaults(m.reflexes, m.seats.reflex.provider),
    policy: { ...m.policy, approvals: { ...m.policy.approvals, required: withPrApproval(m.policy.approvals.required) } },
  }));

type ReflexSettingValue = 'rule' | 'model' | 'frontier';

/** D2: an unset seam is 'model' when a decision-model provider is configured, else 'rule'. */
function resolveReflexDefaults<T extends { threshold: number } & Partial<Record<'triage' | 'choosePlan' | 'route' | 'gate' | 'reconsider' | 'closeOut', ReflexSettingValue>>>(
  r: T,
  provider: string,
): { triage: ReflexSettingValue; choosePlan: ReflexSettingValue; route: ReflexSettingValue; gate: ReflexSettingValue; reconsider: ReflexSettingValue; closeOut: ReflexSettingValue; threshold: number } {
  const d: ReflexSettingValue = provider !== 'rules' ? 'model' : 'rule';
  return {
    triage: r.triage ?? d,
    choosePlan: r.choosePlan ?? d,
    route: r.route ?? d,
    gate: r.gate ?? d,
    reconsider: r.reconsider ?? d,
    closeOut: r.closeOut ?? d,
    threshold: r.threshold,
  };
}

/** The PR approval is never optional (D6): 'open_pr' is always in the resolved approvals.required. */
function withPrApproval(required: string[]): string[] {
  return required.includes('open_pr') ? required : [...required, 'open_pr'];
}

export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestInput = z.input<typeof ManifestSchema>;

export class ManifestError extends Error {
  constructor(message: string, public readonly issues: ReadonlyArray<{ path: string; message: string }>) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** Find credential-looking string leaves anywhere in a Json document. */
export function findSecretLeaks(doc: Json): Array<{ path: string; kind: string }> {
  const hits: Array<{ path: string; kind: string }> = [];
  for (const leaf of stringLeaves(doc)) {
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(leaf.value)) hits.push({ path: leaf.path, kind: p.kind });
    }
  }
  return hits;
}

/** Parse and validate a manifest document. Throws ManifestError with every issue collected. */
export function parseManifest(doc: unknown): Manifest {
  const leaks = findSecretLeaks(doc as Json);
  if (leaks.length) {
    throw new ManifestError(
      `manifest contains credential-looking values; use references (env:/file:/keychain:)`,
      leaks.map((l) => ({ path: l.path, message: `looks like a ${l.kind} secret` })),
    );
  }
  const r = ManifestSchema.safeParse(doc);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new ManifestError(`invalid manifest: ${issues.map((i) => `${i.path || '<root>'}: ${i.message}`).join('; ')}`, issues);
  }
  return r.data;
}

/** Stable hash of the resolved manifest (defaults applied, keys sorted). Recorded with every run. */
export function manifestHash(m: Manifest): string {
  return sha256(canonicalJson(m as unknown as Json));
}
