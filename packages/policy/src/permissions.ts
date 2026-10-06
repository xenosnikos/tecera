import { z } from 'zod';

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
  return p;
}

/** Most restrictive class wins; an unlisted action is undefined (the gate reflex treats it by risk). */
export function classify(action: string, doc: PermissionsDoc): PermissionClass | undefined {
  if (doc.never.includes(action)) return 'never';
  if (doc.requiresApproval.includes(action)) return 'requiresApproval';
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
