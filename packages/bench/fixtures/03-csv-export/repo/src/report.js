// Sales report: totals per region, sorted by region name.
export function summarize(rows) {
  const totals = new Map();
  for (const r of rows) totals.set(r.region, (totals.get(r.region) ?? 0) + r.amount);
  return [...totals]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([region, total]) => ({ region, total }));
}

export function formatText(summary) {
  return summary.map((s) => `${s.region.padEnd(16)} ${s.total.toFixed(2).padStart(10)}`).join('\n') + '\n';
}
