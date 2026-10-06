import type { Json, JsonObject } from '@tecera/contracts';

/**
 * Minimal JSON-schema check for return values (no new dependencies): type (single or list), required,
 * properties, additionalProperties:false, items, enum, const, minLength/maxLength, minItems/maxItems.
 * Unknown keywords are ignored; the policy returnSchema hook is the authority on stricter rules.
 */

const typeOf = (v: Json): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v);

function matchesType(v: Json, t: string): boolean {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

export function validateSchema(value: Json | undefined, schema: JsonObject, path = '$', errors: string[] = []): string[] {
  if (errors.length > 20) return errors;
  if (value === undefined) {
    errors.push(`${path}: value is missing`);
    return errors;
  }
  const s = schema as {
    type?: string | string[];
    required?: string[];
    properties?: Record<string, JsonObject>;
    additionalProperties?: boolean | JsonObject;
    items?: JsonObject;
    enum?: Json[];
    const?: Json;
    minLength?: number;
    maxLength?: number;
    minItems?: number;
    maxItems?: number;
  };
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${path}: not one of ${JSON.stringify(s.enum)}`);
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(value)) errors.push(`${path}: must equal ${JSON.stringify(s.const)}`);
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) errors.push(`${path}: longer than ${s.maxLength}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) errors.push(`${path}: more than ${s.maxItems} items`);
    if (s.items && typeof s.items === 'object') value.forEach((v, i) => validateSchema(v, s.items!, `${path}[${i}]`, errors));
  } else if (value && typeof value === 'object') {
    const obj = value as JsonObject;
    for (const k of s.required ?? []) if (!(k in obj)) errors.push(`${path}.${k}: required`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in obj) validateSchema(obj[k], sub, `${path}.${k}`, errors);
    if (s.additionalProperties === false) {
      for (const k of Object.keys(obj)) if (!(k in (s.properties ?? {}))) errors.push(`${path}.${k}: not allowed`);
    } else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      for (const k of Object.keys(obj)) if (!(k in (s.properties ?? {}))) validateSchema(obj[k], s.additionalProperties, `${path}.${k}`, errors);
    }
  }
  return errors;
}
