// Turn free text into a URL slug: lower-case words joined by single dashes.
export function slugify(input) {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, (m) => '-'.repeat(m.length)).replace(/^-+|-+$/g, '');
}
