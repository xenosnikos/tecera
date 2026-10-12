// signup(user, deps) registers a user and returns its record. deps.mailer is the mail sender declared as the
// `mail` connection in tecera.json: { send({ to, subject, text }) => Promise<void> }.
const users = [];

export async function signup(user, deps = {}) {
  if (!user || typeof user.email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(user.email)) throw new Error('a valid email is required');
  const record = { id: users.length + 1, email: user.email, name: user.name ?? '' };
  users.push(record);
  void deps;
  return record;
}
