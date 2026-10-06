/**
 * Structured-output schema compatibility checks for the two adapters' default modes. Offline and
 * conservative: a schema that passes is inside the subset both vendors document as supported; a schema
 * that fails gets one line per problem (JSON pointer + reason). These are used by tests (the planner's
 * real wire schema is pushed through the real request builders and then checked here) and are available
 * to callers that want to refuse an incompatible schema before sending it.
 *
 * OpenAI Responses `text.format = {type: 'json_schema', strict: true}` (the adapter default):
 * - the root is an object schema (not anyOf);
 * - every object sets `additionalProperties: false` and lists EVERY property in `required` (optional
 *   fields are expressed as a union with null);
 * - only these keywords: type, properties, required, additionalProperties, items, enum, const, anyOf,
 *   $ref, $defs, description, title, and the numeric/array constraints minimum, maximum,
 *   exclusiveMinimum, exclusiveMaximum, multipleOf, minItems, maxItems, plus pattern/format on strings.
 *   Not allowed: allOf, not, oneOf, if/then/else, patternProperties, propertyNames, unevaluated*,
 *   min/maxProperties, uniqueItems, contains, minLength/maxLength, dependent*;
 * - at most 10 levels of object nesting, 5000 properties and 1000 enum values in total.
 *
 * Anthropic Messages `output_config.format = {type: 'json_schema'}` (the adapter default):
 * - every object sets `additionalProperties: false` (`required` may be a subset);
 * - no numerical constraints (minimum, maximum, exclusive*, multipleOf), no string length constraints
 *   (minLength, maxLength), no array constraints beyond minItems 0 or 1 (no maxItems, uniqueItems,
 *   contains), no propertyNames / patternProperties / min/maxProperties, no recursive or external $ref;
 * - supported: type, properties, required, additionalProperties: false, items, enum, const, anyOf, allOf,
 *   $ref/$defs (internal, non-recursive), description, title, default, format, pattern.
 */

type Schema = Record<string, unknown>;

const isObj = (v: unknown): v is Schema => !!v && typeof v === 'object' && !Array.isArray(v);

const OPENAI_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', '$ref', '$defs', 'description', 'title',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'pattern', 'format',
]);
const ANTHROPIC_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'allOf', '$ref', '$defs', 'definitions',
  'description', 'title', 'default', 'format', 'pattern', 'minItems',
]);
const JSON_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

interface Walk {
  problems: string[];
  properties: number;
  enumValues: number;
  refs: Set<string>;
}

function typesOf(s: Schema): string[] {
  const t = s['type'];
  return typeof t === 'string' ? [t] : Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
}

function walk(vendor: 'openai' | 'anthropic', s: unknown, path: string, depth: number, w: Walk): void {
  if (!isObj(s)) {
    w.problems.push(`${path || '/'}: schema must be an object`);
    return;
  }
  const allowed = vendor === 'openai' ? OPENAI_KEYWORDS : ANTHROPIC_KEYWORDS;
  for (const k of Object.keys(s)) {
    if (path === '' && k === '$schema') continue;
    if (!allowed.has(k)) w.problems.push(`${path || '/'}: keyword "${k}" is not supported`);
  }
  if (vendor === 'anthropic' && 'minItems' in s && s['minItems'] !== 0 && s['minItems'] !== 1) w.problems.push(`${path || '/'}: minItems must be 0 or 1`);
  const types = typesOf(s);
  for (const t of types) if (!JSON_TYPES.has(t)) w.problems.push(`${path || '/'}: unknown type "${t}"`);
  const hasShape = types.length > 0 || 'anyOf' in s || 'allOf' in s || 'enum' in s || 'const' in s || '$ref' in s;
  if (!hasShape) w.problems.push(`${path || '/'}: schema has no type (an unconstrained value is not allowed)`);
  if (typeof s['$ref'] === 'string') {
    const ref = s['$ref'];
    if (!ref.startsWith('#/$defs/') && !ref.startsWith('#/definitions/')) w.problems.push(`${path}: only internal $ref is supported`);
    else w.refs.add(ref);
  }
  if (Array.isArray(s['enum'])) w.enumValues += s['enum'].length;
  const isObject = types.includes('object') || 'properties' in s;
  if (isObject) {
    if (depth > 10) w.problems.push(`${path}: nested deeper than 10 object levels`);
    if (s['additionalProperties'] !== false) w.problems.push(`${path || '/'}: object must set additionalProperties: false`);
    const props = isObj(s['properties']) ? s['properties'] : {};
    const keys = Object.keys(props);
    w.properties += keys.length;
    const required = Array.isArray(s['required']) ? s['required'] : [];
    for (const r of required) if (typeof r !== 'string' || !keys.includes(r)) w.problems.push(`${path || '/'}: required names unknown property "${String(r)}"`);
    if (vendor === 'openai') for (const k of keys) if (!required.includes(k)) w.problems.push(`${path || '/'}: property "${k}" must be required (use a null union for optional fields)`);
    for (const k of keys) walk(vendor, props[k], `${path}/properties/${k}`, depth + 1, w);
  }
  if ('items' in s) {
    if (Array.isArray(s['items'])) w.problems.push(`${path}: tuple items are not supported`);
    else walk(vendor, s['items'], `${path}/items`, depth, w);
  }
  for (const comb of ['anyOf', 'allOf'] as const) {
    if (!(comb in s)) continue;
    const list = s[comb];
    if (!Array.isArray(list) || list.length === 0) {
      w.problems.push(`${path || '/'}: ${comb} must be a non-empty array`);
      continue;
    }
    list.forEach((sub, i) => walk(vendor, sub, `${path}/${comb}/${i}`, depth, w));
  }
  for (const defs of ['$defs', 'definitions'] as const) {
    if (!isObj(s[defs])) continue;
    for (const [k, v] of Object.entries(s[defs])) walk(vendor, v, `${path}/${defs}/${k}`, depth, w);
  }
}

function check(vendor: 'openai' | 'anthropic', schema: unknown): string[] {
  const w: Walk = { problems: [], properties: 0, enumValues: 0, refs: new Set() };
  if (!isObj(schema)) return ['/: schema must be an object'];
  if (vendor === 'openai') {
    if (!typesOf(schema).includes('object') || typesOf(schema).length !== 1) w.problems.push('/: the root must be a plain object schema');
    if ('anyOf' in schema) w.problems.push('/: the root must not be anyOf');
  }
  walk(vendor, schema, '', 1, w);
  if (vendor === 'openai') {
    if (w.properties > 5000) w.problems.push(`/: ${w.properties} properties (at most 5000)`);
    if (w.enumValues > 1000) w.problems.push(`/: ${w.enumValues} enum values (at most 1000)`);
  }
  if (vendor === 'anthropic' && w.refs.size) w.problems.push('/: $ref is not checked for recursion here; inline the definitions');
  return w.problems;
}

/** Problems that make `schema` invalid for OpenAI strict json_schema output; empty when compatible. */
export function openAIStrictSchemaProblems(schema: unknown): string[] {
  return check('openai', schema);
}

/** Problems that make `schema` invalid for Anthropic output_config.format json_schema; empty when compatible. */
export function anthropicSchemaProblems(schema: unknown): string[] {
  return check('anthropic', schema);
}
