/**
 * Hostile verdict parsing, port of EEZE runtime._approved. The reviewer must answer with exactly one
 * JSON object `{"verdict": "approve"|"reject", "findings": [...]}` and nothing else. Approve requires an
 * empty findings array. Fences, prose, extra keys, multiple documents, or anything found by substring
 * search are rejected. For CLI envelopes, only the provider's final structured message is examined.
 */

export interface Verdict {
  verdict: 'approve' | 'reject';
  findings: Array<{ title: string; detail?: string; path?: string }>;
}

export function parseVerdict(raw: string | null | undefined): Verdict | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const keys = Object.keys(obj).sort();
  if (keys.join(',') !== 'findings,verdict') return null;
  const { verdict, findings } = obj as { verdict: unknown; findings: unknown };
  if (verdict !== 'approve' && verdict !== 'reject') return null;
  if (!Array.isArray(findings)) return null;
  const items: Verdict['findings'] = [];
  for (const f of findings) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
    const { title, detail, path } = f as Record<string, unknown>;
    if (typeof title !== 'string' || title.length === 0) return null;
    if (detail !== undefined && typeof detail !== 'string') return null;
    if (path !== undefined && typeof path !== 'string') return null;
    items.push({ title, detail, path });
  }
  if (verdict === 'approve' && items.length > 0) return null;
  return { verdict, findings: items };
}

/** Claude Code `--output-format json` envelope: one `result` object with subtype success and no denials. */
export function extractClaudeResult(envelope: unknown): string | null {
  if (!envelope || typeof envelope !== 'object') return null;
  const e = envelope as Record<string, unknown>;
  if (e.type !== 'result' || e.subtype !== 'success' || e.is_error !== false) return null;
  if (Array.isArray(e.permission_denials) && e.permission_denials.length > 0) return null;
  return typeof e.result === 'string' ? e.result : null;
}

/** Codex `exec --json` JSONL: exactly one turn.completed, no error/turn.failed, the last agent_message text. */
export function extractCodexResult(jsonl: string): string | null {
  let completed = 0;
  let last: string | null = null;
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(t) as Record<string, unknown>;
    } catch {
      return null;
    }
    const type = ev.type as string | undefined;
    if (type === 'error' || type === 'turn.failed') return null;
    if (type === 'turn.completed') completed++;
    if (type === 'item.completed') {
      const item = ev.item as Record<string, unknown> | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') last = item.text;
    }
  }
  if (completed !== 1) return null;
  return last;
}
