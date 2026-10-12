import { HOST_FUNCTIONS, mockRegistrationProblem, RESERVED_BINDINGS, type CapabilityRecord, type MockToolDeclaration, type Tool } from '@tecera/contracts';
import { hostGateActionOf } from '../broker/hostGates.js';
import { HOST_FUNCTION_BINDINGS } from '../protocol/prompts.js';

/**
 * Admission of stand-ins (the mock rung of the gap ladder). Only the host registers a stand-in, through
 * BrokerOptions.standIns; a program has no call that asks for one, and a tool that claims to stand in for a
 * capability (Tool.standsIn) without being admitted here is refused, so a mock can never be served as if it
 * were real and a real tool can never be passed off as a mock.
 *
 * A stand-in is admitted only when:
 *  - there is a capability inventory to check it against (none → every mock is refused: fail closed);
 *  - mockRegistrationProblem accepts its declaration against the inventory row and the connection (never
 *    for an available or provisioned capability, never for a connection that says mockable: false);
 *  - its tool is the declared tool: same name, exactly the declared methods, standsIn (when set) the
 *    declared capability;
 *  - its tool name and program binding collide with no real tool, binding, reserved name or host function,
 *    and no call on it would be a host gate (push, PR, merge);
 *  - no other stand-in serves the same capability or tool.
 */

/** A declaration and the host-side tool that serves it. */
export interface StandIn {
  declaration: MockToolDeclaration;
  tool: Tool;
}

export interface MockAdmission {
  /** The capability inventory of the run (capabilityInventoryOf). Absent → every stand-in is refused. */
  inventory?: readonly CapabilityRecord[];
  /** Manifest connections by capability id; `mockable: false` refuses a stand-in. */
  connections?: Readonly<Record<string, { mockable?: boolean }>>;
}

export class MockRegistrationError extends Error {
  constructor(readonly problems: string[]) {
    super(`stand-in refused: ${problems.join('; ')}`);
    this.name = 'MockRegistrationError';
  }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

/**
 * Why the stand-ins may not be served next to `tools` (empty when every one may). `bindingOf` is the
 * broker's program binding of a tool name.
 */
export function standInProblems(tools: readonly Tool[], standIns: readonly StandIn[] | undefined, a: MockAdmission, bindingOf: (tool: string) => string): string[] {
  const problems: string[] = [];
  for (const t of tools) if (t && typeof t.standsIn === 'string') problems.push(`tool ${t.name} claims to stand in for ${t.standsIn} but was not admitted as a stand-in`);
  const list = standIns ?? [];
  if (!list.length) return problems;
  if (!Array.isArray(a.inventory)) return [...problems, 'stand-ins need the capability inventory to be checked against; none was given'];
  const byId = new Map(a.inventory.map((r) => [r.id, r]));
  const realNames = new Set(tools.map((t) => t.name));
  const taken = new Set<string>([...tools.map((t) => bindingOf(t.name)), ...RESERVED_BINDINGS, '__history__', ...Object.values(HOST_FUNCTIONS), ...Object.values(HOST_FUNCTION_BINDINGS), 'console']);
  const caps = new Set<string>();
  const names = new Set<string>();
  for (const s of list) {
    const d = s?.declaration;
    const t = s?.tool;
    if (!d || !t) {
      problems.push('a stand-in needs a declaration and a tool');
      continue;
    }
    const why = mockRegistrationProblem(d, byId.get(d.capability), a.connections?.[d.capability]);
    if (why) {
      problems.push(why);
      continue;
    }
    if (t.name !== d.tool) problems.push(`stand-in for ${d.capability} serves tool ${t.name}, the declaration says ${d.tool}`);
    if (!sameSet(t.methods, d.methods)) problems.push(`stand-in for ${d.capability} must serve exactly the declared methods (${d.methods.join(', ')})`);
    if (t.standsIn !== undefined && t.standsIn !== d.capability) problems.push(`stand-in tool ${t.name} says it stands in for ${t.standsIn}, the declaration says ${d.capability}`);
    if (!IDENT.test(d.tool)) problems.push(`stand-in tool name ${JSON.stringify(d.tool)} is not an identifier`);
    if (realNames.has(d.tool) || taken.has(d.tool) || taken.has(bindingOf(d.tool))) problems.push(`stand-in tool ${d.tool} would shadow a real tool, binding or host name`);
    const gate = [...d.methods, 'call'].map((m) => hostGateActionOf(d.tool, m)).find((x) => x !== undefined);
    if (gate) problems.push(`stand-in tool ${d.tool} would perform the host gate ${gate}`);
    if (caps.has(d.capability)) problems.push(`two stand-ins for capability ${d.capability}`);
    if (names.has(d.tool)) problems.push(`two stand-ins serve tool ${d.tool}`);
    caps.add(d.capability);
    names.add(d.tool);
  }
  return problems;
}
