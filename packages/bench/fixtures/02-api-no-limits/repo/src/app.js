// A tiny JSON API. createApp(options) returns handle(request) -> { status, headers, body }.
// A request is { ip, path }. options.now is the clock in epoch ms (default Date.now).
// options.rateLimit ({ limit, windowMs }) is accepted but not enforced yet.
export function createApp(options = {}) {
  const now = options.now ?? Date.now;
  void now;
  return function handle(req) {
    if (req.path === '/health') return { status: 200, headers: {}, body: { ok: true } };
    if (req.path === '/items') return { status: 200, headers: {}, body: { items: ['apple', 'pear'] } };
    return { status: 404, headers: {}, body: { error: 'not found' } };
  };
}
