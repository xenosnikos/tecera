import { resolveGap, type Criterion, type Manifest, type PlanningContext } from '@tecera/contracts';
import { renderDeclared } from './apiSurface.js';
import type { RepoFacts } from './repoFacts.js';
import { safeSegment } from './schema.js';

/**
 * How a capability a contract requires reaches the work, and where its tool may be used.
 *
 * A missing capability that is stood in for, and a provisioned sqlite or http-stub, are served to the worker
 * as a brokered tool named after the capability. That tool exists only inside the worker's sandbox session,
 * for the worker's own exploration and checks. It is not a module the repository can import and it is not
 * defined when the criteria run: product code that calls it (`mail.send(…)` in src) fails with a
 * ReferenceError at verify. Product code reaches the capability through the repository's own seam (an injected
 * dependency such as `deps.mailer`, or the provisioned locator), and the criteria inject a fake through that
 * seam. A generated plan whose step instruction tells the worker to use the tool from the code is refused, and
 * so is one that never names the seam the existing code declares for a stood-in capability
 * (standInInstructionIssues): a coarse static screen over the instruction text, nothing more.
 */

/** Where a required capability stands: usable as it is, created by Tecera, simulated, or a human's call. */
export type CapabilityRung = 'available' | 'provisioned' | 'provision' | 'mock' | 'ask';

export interface CapabilityRoute {
  id: string;
  kind: string;
  rung: CapabilityRung;
  /** True when the worker gets a brokered tool named `id` (a stand-in, or a provisioned sqlite / http-stub). */
  tool: boolean;
}

/** Provisioned kinds a worker reaches through a brokered tool named after the capability. */
export const TOOL_KINDS: ReadonlySet<string> = new Set(['sqlite', 'http-stub']);

export interface CapabilityRouteInput {
  manifest: Manifest;
  /** The criteria the plan answers to (their `requires` name the capabilities). */
  criteria: readonly Criterion[];
  planning?: PlanningContext;
}

/** One route per capability the criteria require (at most 16), in the order they are first required. */
export function capabilityRoutes(i: CapabilityRouteInput): CapabilityRoute[] {
  const ids = [...new Set((Array.isArray(i.criteria) ? i.criteria : []).flatMap((k) => (Array.isArray(k.requires) ? k.requires : [])))];
  const inv = i.planning?.inventory ?? [];
  const allowance = i.planning?.allowance;
  return ids.slice(0, 16).map((id) => {
    const rec = inv.find((r) => r.id === id);
    const conn = i.manifest.connections?.[id];
    const kind = rec?.kind ?? conn?.kind ?? 'unknown';
    const state = rec?.state ?? 'missing';
    const gap = allowance ? resolveGap({ kind, available: false, mockable: conn?.mockable !== false }, allowance, i.planning?.provisionedSoFar ?? 0) : 'ask';
    const rung: CapabilityRung = state === 'available' || state === 'provisioned' ? state : state === 'mocked' ? 'mock' : gap === 'mock' || gap === 'provision' ? gap : 'ask';
    return { id, kind, rung, tool: rung === 'mock' || ((rung === 'provisioned' || rung === 'provision') && TOOL_KINDS.has(kind)) };
  });
}

// ---------- the repository's own seam ----------

/** A place the existing code takes a dependency from its caller. */
export interface Seam {
  /** How the code reads it (`deps.mailer`, or the parameter name alone). */
  path: string;
  /** The declaration that carries it (`signup(user, deps = {})`). */
  declared: string;
  module: string;
}

const MESSAGE_WORDS = /mailer|sender|smtp|notifier|messenger|transport|outbox|queue|^mail$|^send|^sms$/i;
const STORE_WORDS = /^db$|database|store|storage|sql|^repo|^kv$|cache/i;
const HTTP_WORDS = /http|fetch|client|^api$|webhook/i;
const INJECTED = /^(deps|dependencies|services|ctx|context|adapters?|clients?|io|ports)$/i;

/** The member names that would carry a capability of this kind or id. */
function wordsFor(kind: string, id: string): RegExp {
  const k = `${kind} ${id}`;
  return /mail|smtp|sms|messag|notif|queue|chat/i.test(k) ? MESSAGE_WORDS : /sql|db|database|store|kv|redis|postgres/i.test(k) ? STORE_WORDS : /http|api|webhook/i.test(k) ? HTTP_WORDS : new RegExp(id.replace(/[^a-z0-9]/gi, ''), 'i');
}

/**
 * The seams the existing tested API declares for a capability: a parameter member whose name fits the
 * capability (`deps.mailer` for mail), else a parameter that is plainly an injected-dependency bag (`deps`).
 * Empty when the host read no module text or nothing fits. At most 4.
 */
export function seamsFor(repo: RepoFacts | undefined, kind: string, id: string): Seam[] {
  const words = wordsFor(kind, id);
  const named: Seam[] = [];
  const bags: Seam[] = [];
  for (const t of repo?.testedApi ?? []) {
    for (const c of t.calls ?? []) {
      for (const p of c.params ?? []) {
        if (/^[{[]/.test(p.name) && !p.members.length) continue;
        const declared = renderDeclared(c.name, c.params ?? []);
        const fits = p.members.filter((m) => words.test(m));
        const prefix = /^[{[]/.test(p.name) ? '' : `${p.name}.`;
        for (const m of fits) named.push({ path: `${prefix}${m}`, declared, module: t.module });
        if (!fits.length && INJECTED.test(p.name)) bags.push({ path: p.name, declared, module: t.module });
      }
    }
  }
  return (named.length ? named : bags).slice(0, 4);
}

// ---------- the screen ----------

const NEGATED = /\b(?:never|not|no|without|instead of|rather than|avoid\w*|dont)\b|n't\b/i;
const OWN_USE = /\b(?:your own|own checks?|only (?:for|to|in) (?:your|the worker)|explor\w*|inspect\w*|experiment\w*)\b|\btry\w*\b.*\bfirst\b|\bfirst\b.*\btry/i;
/** Where one clause of a sentence ends and the next begins. */
const CLAUSE_BREAK = /[,;:()]|\s(?:but|then)\s/gi;
/** A negation governs what follows it closely: this many words at most. */
const NEGATION_REACH = 8;
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where a sentence names the tool `id` (start and end of each mention): "the mail tool", "`mail` stand-in",
 * "the tool named mail", "tool `mail`", `mail.send(`, and a backticked `mail.send`.
 */
function toolMentions(sentence: string, id: string): Array<[number, number]> {
  const x = esc(id);
  const forms = [
    new RegExp(`(?<![\\w$.-])\`?${x}\`?(?:'s)?\\s+(?:tool|stand-in)\\b`, 'gi'),
    new RegExp(`\\b(?:tool|stand-in)\\s+(?:(?:named|called)\\s+\`?${x}\`?(?![\\w$-])|\`${x}\`)`, 'gi'),
    new RegExp(`(?<![\\w$.-])${x}\\s*\\.\\s*[A-Za-z_$][\\w$]*\\s*\\(`, 'g'),
    new RegExp(`\`${x}\\s*\\.\\s*[A-Za-z_$][\\w$]*`, 'g'),
  ];
  return forms.flatMap((re) => [...sentence.matchAll(re)].map((m): [number, number] => [m.index!, m.index! + m[0].length]));
}

/**
 * True when a mention of the tool is one the worker may act on without putting it in the code: the clause
 * forbids it (a negation within a few words before the mention: "never call the mail tool") or keeps it to the
 * worker's own checks ("use the mail tool only for your own checks", "try it on the mail tool first"). A
 * negation or "try" elsewhere in the sentence says nothing about the tool and does not count.
 */
function keptOutOfCode(sentence: string, [start, end]: [number, number]): boolean {
  const breaks = [...sentence.matchAll(CLAUSE_BREAK)].map((m) => [m.index!, m.index! + m[0].length] as const);
  const from = Math.max(0, ...breaks.filter(([, e]) => e <= start).map(([, e]) => e));
  const to = Math.min(sentence.length, ...breaks.filter(([b]) => b >= end).map(([b]) => b));
  const lead = sentence.slice(from, start).trim().split(/\s+/).slice(-NEGATION_REACH).join(' ');
  return NEGATED.test(lead) || OWN_USE.test(sentence.slice(from, to));
}

/**
 * Why a plan's worker instructions would put a brokered capability tool into product code (empty when none
 * does). A sentence that names the tool of a route with `tool` is refused unless that mention is forbidden or
 * kept to the worker's own checks (keptOutOfCode). For a stood-in capability whose seam the host read from the
 * existing code (`deps.mailer`), the instructions must also name that seam: a plan that never says where the
 * code sends leaves the worker with the tool as the only thing named. `repo` supplies the seam. Never throws.
 */
export function standInInstructionIssues(steps: ReadonlyArray<{ id: string; kind: string; instruction?: string | undefined }>, routes: readonly CapabilityRoute[], repo?: RepoFacts): string[] {
  const out: string[] = [];
  try {
    const tools = routes.filter((r) => r.tool);
    if (!tools.length) return out;
    const workers = steps.filter((s) => s.kind === 'worker' && typeof s.instruction === 'string');
    for (const r of tools) {
      const seams = seamsFor(repo, r.kind, r.id);
      const named = seams.map((x) => `${x.path} of ${x.declared} in ${x.module}`).join('; ');
      let refused = false;
      for (const s of workers) {
        const sentences = s.instruction!.split(/(?<=[.!?;])\s+|\n+/);
        if (!sentences.some((x) => toolMentions(x, r.id).some((at) => !keptOutOfCode(x, at)))) continue;
        refused = true;
        const through = r.rung === 'mock' ? (seams.length ? `the repository's own seam: ${named}` : "the repository's own seam (an injected dependency the existing code takes)") : 'its own code and the location the criteria read from the environment';
        // Kept short: diagnostics are bounded, and the seam is the part the repair round needs.
        out.push(`step ${safeSegment(s.id)} has the code use the ${safeSegment(r.id)} tool, which exists only in the worker's sandbox session (for its own checks) and is not defined when the criteria run; the code must reach the capability through ${through}`);
      }
      // The seam's member (`mailer` of deps.mailer) appears in no instruction: the worker is never told where the code sends.
      const members = seams.filter((x) => x.path.includes('.')).map((x) => x.path.split('.').pop()!);
      if (!refused && r.rung === 'mock' && members.length && workers.length && !workers.some((s) => members.some((m) => new RegExp(`(?<![\\w$])${esc(m)}(?![\\w$])`).test(s.instruction!)))) {
        out.push(`no step instruction names the repository's own seam for ${safeSegment(r.id)} (${named}); say that the code reaches the capability through it, since the ${safeSegment(r.id)} tool is not defined when the criteria run`);
      }
    }
  } catch {
    out.push('plan instructions could not be screened for stand-in tool use; refusing');
  }
  return out;
}
