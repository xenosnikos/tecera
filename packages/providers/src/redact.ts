import { makeRedactor, type Redactor } from '@tecera/contracts';

/**
 * Thin re-exports of the one shared redactor (@tecera/contracts redact.ts). This package keeps no
 * redaction logic of its own: every secret value, encoding, cut edge and SECRET_PATTERNS match is
 * handled there, and secrets shorter than MIN_SECRET_CHARS are refused (RedactionError) rather than
 * silently left unredacted.
 */
export {
  makeRedactor,
  redactText,
  redactJson,
  containsSecret,
  secretNeedles,
  sha8,
  redactionMarker,
  RedactionError,
  MIN_SECRET_CHARS,
  type Redactor,
  type SecretInput,
} from '@tecera/contracts';

let patternsOnly: Redactor | null = null;

/** A redactor with no known values: SECRET_PATTERNS (key shapes, JWTs, canaries) only. */
export function patternRedactor(): Redactor {
  return (patternsOnly ??= makeRedactor([]));
}
