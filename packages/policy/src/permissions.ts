import { z } from 'zod';
import { ACCEPT_CRITERIA_ACTION, ANSWER_CRITERION_ACTION } from '@tecera/contracts';

/**
 * permissions.json is the authority (the markdown next to it is a rendered view). Humans edit it; the
 * agent never does. Actions are strings like `read`, `edit`, `commit`, `git_push`, `write_outside_allowed`.
 */
export const PermissionsSchema = z
  .object({
    always: z.array(z.string().min(1)).default([]),
    requiresApproval: z.array(z.string().min(1)).default([]),
    never: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type PermissionsDoc = z.infer<typeof PermissionsSchema>;
export type PermissionClass = 'always' | 'requiresApproval' | 'never';

/**
 * D6 (2026-10-05): commits go to the work branch without approval; opening a PR and pushing need a human
 * approval, which only the gate.pr step consumes; merging is never Tecera's.
 */
export const DEFAULT_PERMISSIONS: PermissionsDoc = {
  always: ['read', 'listFiles', 'runVerify', 'commit'],
  requiresApproval: ['open_pr', 'git_push', 'externalWrite'],
  never: ['delete_tests', 'edit_protected_paths', 'merge', 'modify_tecera_config', 'disable_hooks'],
};

/** Actions only the gate.pr step performs, on the human approval it consumes (never a worker tool call). */
export const PR_GATE_ACTIONS: ReadonlySet<string> = new Set(['open_pr', 'git_push', 'gh_pr', 'pr_create', 'gh_pr_create']);

/** Actions nobody in Tecera performs (D6: Tecera never merges). */
export const MERGE_ACTIONS: ReadonlySet<string> = new Set(['merge', 'git_merge', 'gh_merge', 'pr_merge', 'gh_pr_merge']);

/**
 * Approval-only actions (D8): a human grants them through the ledger's approval rows and nothing else performs
 * them. Accepting the criteria is the requestor's sign-off before planning; answering a human criterion is the
 * reviewer's at the PR hold. No worker tool call, plan declaration or `always` entry can grant either.
 */
export const APPROVAL_ONLY_ACTIONS: ReadonlySet<string> = new Set([ACCEPT_CRITERIA_ACTION, ANSWER_CRITERION_ACTION]);

/** Approval requirements D6 made obsolete: writes inside allowedChanges on the work branch, and commits, need none. */
export const OBSOLETE_WRITE_APPROVALS: ReadonlySet<string> = new Set(['edit', 'write', 'edit_write', 'edit_edit', 'write_file', 'commit', 'git_commit']);

export class PermissionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionsError';
  }
}

export function parsePermissions(doc: unknown): PermissionsDoc {
  const r = PermissionsSchema.safeParse(doc);
  if (!r.success) throw new PermissionsError(`invalid permissions: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const p = r.data;
  const seen = new Map<string, PermissionClass>();
  for (const cls of ['never', 'requiresApproval', 'always'] as const) {
    for (const a of p[cls]) {
      const prev = seen.get(a);
      if (prev && prev !== cls) throw new PermissionsError(`action ${a} appears in both ${prev} and ${cls}`);
      seen.set(a, cls);
    }
  }
  for (const a of p.always) if (APPROVAL_ONLY_ACTIONS.has(a)) throw new PermissionsError(`action ${a} is approval-only: it cannot be always allowed`);
  return p;
}

/**
 * D6 placement (sprint 5 item 5), for `validate --strict`: commit in always; open_pr and git_push in
 * requiresApproval; merge in never; no approval requirement on in-bounds writes or commits; approval-only
 * actions never always allowed. Empty when the document is in order.
 */
export function permissionsProblems(doc: PermissionsDoc): string[] {
  const out: string[] = [];
  const want: Array<[string, PermissionClass]> = [['commit', 'always'], ['open_pr', 'requiresApproval'], ['git_push', 'requiresApproval'], ['merge', 'never']];
  for (const [a, cls] of want) {
    const at = (['always', 'requiresApproval', 'never'] as const).filter((c) => doc[c].includes(a));
    if (at.length !== 1 || at[0] !== cls) out.push(`${a} must be listed in ${cls} only (found ${at.length ? at.join(', ') : 'nowhere'})`);
  }
  for (const a of doc.requiresApproval) {
    if (OBSOLETE_WRITE_APPROVALS.has(a) && a !== 'commit') out.push(`requiresApproval lists ${a}: obsolete, writes inside allowedChanges on the work branch need no approval (D6)`);
  }
  for (const a of doc.always) if (APPROVAL_ONLY_ACTIONS.has(a)) out.push(`${a} is approval-only and may not be always allowed`);
  return out;
}

/** Most restrictive class wins; an approval-only action is never 'always'; an unlisted action is undefined (the gate reflex treats it by risk). */
export function classify(action: string, doc: PermissionsDoc): PermissionClass | undefined {
  if (doc.never.includes(action)) return 'never';
  if (doc.requiresApproval.includes(action) || APPROVAL_ONLY_ACTIONS.has(action)) return 'requiresApproval';
  if (doc.always.includes(action)) return 'always';
  return undefined;
}

export function renderPermissions(doc: PermissionsDoc): string {
  const section = (title: string, items: string[]) => `## ${title}\n${items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none)'}`;
  return [
    '# Permissions',
    'Rendered from permissions.json. Edit the JSON, not this file.',
    section('Always allowed (no approval)', doc.always),
    section('Requires approval', doc.requiresApproval),
    section('Never allowed', doc.never),
  ].join('\n\n');
}
