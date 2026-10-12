// Session store: createSessionStore({ path }) keeps the app's sessions.
// Sessions live in memory only today, so they vanish when the process restarts; `path` names where a
// persistent store would keep them.
export function createSessionStore(options = {}) {
  void options;
  const sessions = new Map();
  return {
    set(id, data) {
      sessions.set(id, structuredClone(data));
    },
    get(id) {
      const s = sessions.get(id);
      return s === undefined ? undefined : structuredClone(s);
    },
    delete(id) {
      sessions.delete(id);
    },
    close() {},
  };
}
