import { randomBytes } from 'node:crypto';
import type { Redactor } from '@tecera/contracts';
import { decodedSecretKind, inertRedacted, withheldMarker } from './hygiene.js';

/**
 * Prompt rendering helpers. Redaction is the shared contracts redactor (makeRedactor), applied to decoded
 * values BEFORE any truncation or encoding; nothing here calls JSON.stringify on caller-supplied objects
 * (redactJson walks own data properties only, never getters or toJSON). `untrusted` wraps data in a
 * nonce-tagged envelope the model is told never to obey; the nonce and any envelope tags are escaped out
 * of the content. Every envelope is marked untrusted, whatever provenance the data claims.
 *
 * Order everywhere: redact the WHOLE value, withhold anything whose decoded views (escapes, entities,
 * base64/hex/percent encodings) still carry a secret, and only then flatten and truncate. Nothing is cut
 * before it has been redacted and scanned, so a cut can never leave part of an (encoded) secret behind.
 */

export function newNonce(): string {
  return randomBytes(8).toString('hex');
}

function escapeAttr(s: string): string {
  return s.replace(/[^A-Za-z0-9_.:/@ -]/g, '_').slice(0, 120);
}

/** Remove the nonce and neutralise envelope tags in text that came from outside the host. */
export function defang(text: string, nonce: string): string {
  const out = nonce ? text.split(nonce).join('[nonce]') : text;
  return out.replace(/<(\/?)untrusted/gi, '&lt;$1untrusted');
}

/** Wrap data as untrusted. The content cannot close the envelope or forge the nonce. */
export function untrusted(src: string, body: string, nonce: string): string {
  return `<untrusted src="${escapeAttr(defang(src, nonce))}" provenance-trust="untrusted" nonce="${nonce}">\n${defang(body, nonce)}\n</untrusted nonce="${nonce}">`;
}

/** Bound an already-redacted string, marking the cut. */
export function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

/** Redacted text, or a fixed marker when a decoded view of it still carries a secret. Not truncated. */
function redactedOrWithheld(text: string, r: Redactor): string {
  const red = r.redactText(text);
  const hit = decodedSecretKind(red, r);
  return hit === null ? red : withheldMarker(hit);
}

/** Redact (and decoded-check), then bound, a piece of text. */
export function safeText(text: unknown, r: Redactor, max: number): string {
  if (typeof text !== 'string') return '[not text]';
  return cap(redactedOrWithheld(text, r), max);
}

/**
 * JSON for prompt display: redacted structurally over the whole value first (no getters/toJSON run),
 * decoded-checked, strings cut to `perString` only afterwards, then serialised from the inert copy and
 * bounded to `max`.
 */
export function safeJson(value: unknown, r: Redactor, max: number, perString = max): string {
  const inert = inertRedacted(value, r, perString);
  const s = JSON.stringify(inert) ?? 'null';
  return cap(s, max);
}

/**
 * One diagnostic line: redacted, control characters (and, with `collapse`, all whitespace runs) flattened,
 * redacted again (flattening can join a secret that contains whitespace), decoded-checked, defanged, and
 * only then bounded.
 */
export function safeLine(text: unknown, r: Redactor, nonce: string, max = 300, collapse = false): string {
  if (typeof text !== 'string') return '[not text]';
  const first = r.redactText(text);
  const flat = collapse ? first.replace(/\s+/g, ' ').trim() : first.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ');
  return cap(defang(redactedOrWithheld(flat, r), nonce), max);
}
