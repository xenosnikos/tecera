/**
 * Actions only the host performs (D6): gate.pr pushes and opens the PR on the human approval it consumes,
 * and nobody in Tecera merges. Kept in step with @tecera/policy PR_GATE_ACTIONS and MERGE_ACTIONS (the
 * worker depends on contracts only). A tool call is matched by `<tool>_<method>`, the method and the tool.
 */
export const HOST_GATE_ACTIONS: ReadonlySet<string> = new Set([
  'open_pr',
  'git_push',
  'gh_pr',
  'pr_create',
  'gh_pr_create',
  'merge',
  'git_merge',
  'gh_merge',
  'pr_merge',
  'gh_pr_merge',
]);

/** The host-gate action a tool call would perform, or undefined. */
export function hostGateActionOf(tool: string, method: string): string | undefined {
  const names = [method && method !== 'call' ? `${tool}_${method}` : tool, method, tool].filter((a) => typeof a === 'string' && a !== '');
  return names.find((a) => HOST_GATE_ACTIONS.has(a));
}
