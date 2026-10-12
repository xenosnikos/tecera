import { describe, expect, it } from 'vitest';
import {
  ACCEPT_CRITERIA_ACTION,
  ANSWER_CRITERION_ACTION,
  GENESIS_HASH,
  IllegalTransition,
  acceptCriteriaActionHash,
  acceptedContractOf,
  answerCriterionActionHash,
  achievedProofOf,
  achievementProofProblem,
  approvalGrantedEvent,
  capabilityInventoryOf,
  chainHash,
  contractHash,
  criterionEvidenceKey,
  deriveGoalStatus,
  digest,
  event,
  expiredResources,
  fidelityFor,
  isSimulated,
  ledgerProvenRun,
  locatorProblem,
  markProvisional,
  mockRegistrationProblem,
  payloadOf,
  provenAchievement,
  provenRun,
  provisionalProofProblem,
  resourceProblem,
  resourceRegistryOf,
  signoffTrace,
  simulatedProvenance,
  transitionGoal,
  verifyCommandDigest,
  type AcceptanceContract,
  type AchievementGoal,
  type AchievementProof,
  type CriterionProof,
  type EvidenceRecord,
  type Json,
  type JsonObject,
  type Ledger,
  type MockToolDeclaration,
  type ProvisionedResource,
  type ProvisioningAllowance,
  type TeceraEvent,
} from './index.js';

const sys = { kind: 'system' as const, id: 'loop' };
const agent = { kind: 'agent' as const, id: 'worker' };
const ana = { kind: 'human' as const, id: 'ana' };
const CHECK = { command: 'node --test', timeoutSec: 60 };
const RUN = 'r1';
const ALLOW: ProvisioningAllowance = { scope: 'local', kinds: ['tmpdir', 'git-remote', 'sqlite', 'http-stub'], maxResources: 4, ttlSec: 3600 };

const contract = (o: Partial<AcceptanceContract> = {}): AcceptanceContract => ({
  goalId: 'g',
  statement: 'persist sessions',
  criteria: [
    { id: 'tests', statement: 'the suite passes', check: { kind: 'command', command: CHECK.command, timeoutSec: 60 } },
    { id: 'db', statement: 'sessions survive a restart', check: { kind: 'command', command: 'node db.js', timeoutSec: 30 }, requires: ['db'] },
    { id: 'docs', statement: 'the README says where sessions live', check: { kind: 'human', prompt: 'Is it documented?' } },
  ],
  outOfScope: [],
  assumptions: [],
  ...o,
});

const resource = (o: Partial<ProvisionedResource> = {}): ProvisionedResource => ({
  id: 'res1',
  capability: 'db',
  kind: 'sqlite',
  provider: 'local',
  locator: '/tmp/tecera-res/res1.sqlite',
  teardown: 'rm -f /tmp/tecera-res/res1.sqlite',
  createdAt: 1000,
  expiresAt: 1000 + 3_600_000,
  transfer: 'pending',
  ...o,
});

function builder() {
  const list: TeceraEvent[] = [];
  let n = 0;
  const add = (kind: TeceraEvent['kind'], payload: JsonObject, trace: TeceraEvent['trace'] = {}, actor: TeceraEvent['actor'] = sys, runId = RUN) => {
    n++;
    const e = event(kind, { id: `e${n}`, at: n, actor, payload, trace, runId });
    list.push(e);
    return e;
  };
  const push = (e: TeceraEvent) => list.push(e);
  return { list, add, push };
}

const g = { goalId: 'g' };
const it1 = (stepId?: string) => ({ goalId: 'g', intentionId: 'i1', planId: 'p', ...(stepId ? { stepId } : {}) });

/** Request, grant (audited, by `approver`) and consume an accept_criteria approval for `hash`. */
function signOff(b: ReturnType<typeof builder>, hash: string, o: { rid?: string; approver?: TeceraEvent['actor']; requester?: TeceraEvent['actor']; boundTo?: string; consume?: boolean } = {}) {
  const rid = o.rid ?? 'so1';
  const actionHash = acceptCriteriaActionHash({ goalId: 'g', runId: RUN, contractHash: o.boundTo ?? hash });
  b.add('approval.requested', { requestId: rid, actionHash, sessionId: 's', action: ACCEPT_CRITERIA_ACTION }, signoffTrace('g'), o.requester ?? sys);
  b.push(approvalGrantedEvent({ id: `grant-${rid}`, at: 50, requestId: rid, runId: RUN, sessionId: 's', actionHash, approver: (o.approver ?? ana) as { kind: 'human'; id: string }, trace: signoffTrace('g') }));
  if (o.consume !== false) b.add('approval.consumed', { requestId: rid }, signoffTrace('g'));
  return rid;
}

function body(command: string, fingerprint: string | undefined, extra: JsonObject = {}): Json {
  return { command, commandDigest: verifyCommandDigest(command), timeoutSec: 30, exitCode: 0, outcome: 'passed', ...(fingerprint ? { fingerprint } : {}), ...extra };
}
const rec = (key: string, b: Json, runId = RUN): EvidenceRecord => ({ key, kind: 'gate.verify', runId, digest: digest(b), body: b, seq: 0 });

interface Opts {
  contract?: boolean;
  goalFile?: boolean;
  dbFidelity?: CriterionProof['fidelity'];
  mockDb?: boolean;
  proofHash?: string;
  amendAfterAccept?: boolean;
  docsByRequester?: boolean;
  after?: (b: ReturnType<typeof builder>) => void;
  evidenceFingerprint?: string | null;
  freshDraftOverGoalFile?: boolean;
  skipAnswer?: boolean;
  answer?: AnswerOpts;
}

interface AnswerOpts {
  rid?: string;
  requester?: TeceraEvent['actor'] | null;
  criterionId?: string;
  fingerprint?: string;
  grantFirst?: boolean;
  consume?: boolean;
  consumer?: TeceraEvent['actor'];
  grantSession?: string;
}

/** Ask the human criterion 'docs' (answer_criterion approval), audited grant by ana, consumed by Tecera. */
function answer(b: ReturnType<typeof builder>, hash: string, o: AnswerOpts = {}) {
  const rid = o.rid ?? 'ans1';
  const actionHash = answerCriterionActionHash({ goalId: 'g', runId: RUN, contractHash: hash, criterionId: o.criterionId ?? 'docs', fingerprint: o.fingerprint ?? 'fp1' });
  const grant = () => b.push(approvalGrantedEvent({ id: `grant-${rid}`, at: 61, requestId: rid, runId: RUN, sessionId: o.grantSession ?? 's', actionHash, approver: ana, trace: it1('pr') }));
  if (o.grantFirst) grant();
  const req = event('approval.requested', { id: `req-${rid}`, at: 61, actor: o.requester ?? sys, payload: { requestId: rid, actionHash, sessionId: 's', action: ANSWER_CRITERION_ACTION }, trace: it1('pr'), runId: RUN });
  if (o.requester === null) delete (req as Partial<TeceraEvent>).actor;
  b.push(req);
  if (!o.grantFirst) grant();
  if (o.consume !== false) b.add('approval.consumed', { requestId: rid }, it1('pr'), o.consumer ?? sys);
}

function scenario(o: Opts = {}) {
  const b = builder();
  const c = contract();
  const h = contractHash(c);
  const goal: AchievementGoal = { id: 'g', statement: 'persist sessions', check: CHECK, commitment: 'single-minded', status: 'open', evidence: [], ...(o.goalFile ? { criteria: c.criteria, contractHash: h } : {}) };
  b.add('run.started', { manifestHash: 'm' });
  b.add('goal.adopted', { goal: goal as unknown as JsonObject }, g);
  if (o.contract) {
    if (o.goalFile) {
      b.add('criteria.drafted', payloadOf('criteria.drafted', { contract: c, hash: h, needs: [], source: 'goal-file' }), g);
      b.add('criteria.accepted', payloadOf('criteria.accepted', { hash: h, via: 'goal-file' }), g);
    } else {
      b.add('criteria.drafted', payloadOf('criteria.drafted', { contract: c, hash: h, needs: [{ id: 'db', kind: 'sqlite', criteria: ['db'], mockable: true }], source: 'planner' }), g);
      const rid = signOff(b, h);
      b.add('criteria.accepted', payloadOf('criteria.accepted', { hash: h, via: 'approval', requestId: rid, approver: ana }), g);
    }
    if (o.freshDraftOverGoalFile) {
      const weaker = contract({ criteria: c.criteria.slice(0, 1).concat(c.criteria.slice(1, 2)) as AcceptanceContract['criteria'], assumptions: ['weaker'] });
      const wh = contractHash(weaker);
      b.add('criteria.drafted', payloadOf('criteria.drafted', { contract: weaker, hash: wh, needs: [], source: 'planner' }), g);
      const rid = signOff(b, wh, { rid: 'so2' });
      b.add('criteria.accepted', payloadOf('criteria.accepted', { hash: wh, via: 'approval', requestId: rid }), g);
    }
    b.add('capability.probed', payloadOf('capability.probed', { capability: { id: 'db', kind: 'sqlite', state: 'missing' } }));
    if (o.mockDb) b.add('capability.mocked', payloadOf('capability.mocked', { capability: 'db', kind: 'sqlite', tool: 'db', mockId: 'mock-db', reason: 'not provisionable' }), g);
    else b.add('resource.provisioned', payloadOf('resource.provisioned', { resource: resource() }), g);
  }
  b.add('intention.pushed', { intention: { id: 'i1' } }, it1());
  b.add('verify.passed', { evidenceKey: 'v1', fingerprint: 'fp1', exitCode: 0 }, it1('verify'));
  b.add('approval.requested', { requestId: 'pr1', actionHash: 'x', sessionId: 's' }, it1('pr'));
  b.push(approvalGrantedEvent({ id: 'grant-pr1', at: 60, requestId: 'pr1', runId: RUN, sessionId: 's', actionHash: 'x', approver: ana, trace: it1('pr') }));
  b.add('approval.consumed', { requestId: 'pr1' }, it1('pr'));
  if (o.contract && !o.skipAnswer) answer(b, o.proofHash ?? h, { requester: o.docsByRequester ? ana : sys, ...o.answer });
  if (o.amendAfterAccept) {
    const amended = contract({ assumptions: ['one process'] });
    b.add('criteria.amended', payloadOf('criteria.amended', { from: h, to: contractHash(amended), contract: amended, reason: 'scope' }), g);
  }
  b.add('intention.done', { intention: { id: 'i1' } }, it1());
  const dbFid = o.dbFidelity ?? (o.mockDb ? 'mocked' : 'provisioned');
  const criteria: CriterionProof[] = [
    { criterionId: 'tests', fidelity: 'real', via: 'command', command: CHECK.command, exitCode: 0, fingerprint: 'fp1', evidenceKey: 'v1', verifiedAt: 5 },
    { criterionId: 'db', fidelity: dbFid, via: 'command', command: 'node db.js', exitCode: 0, fingerprint: 'fp1', evidenceKey: criterionEvidenceKey(RUN, 'db', 'fp1'), verifiedAt: 5 },
    { criterionId: 'docs', fidelity: 'real', via: 'human', approver: 'ana', evidenceKey: o.answer?.rid ?? 'ans1', verifiedAt: 6 },
  ];
  const proof: AchievementProof = {
    command: CHECK.command,
    exitCode: 0,
    fingerprint: 'fp1',
    evidenceKey: 'v1',
    verifiedAt: 5,
    ...(o.contract ? { contractHash: o.proofHash ?? h, criteria, fidelity: dbFid === 'mocked' ? 'mocked' : dbFid === 'provisioned' ? 'provisioned' : 'real' } : {}),
  };
  if (o.mockDb) b.add('goal.provisional', payloadOf('goal.provisional', { goal: { ...goal, provisional: true }, proof, mocked: ['db'], reason: 'db is mocked' }), g);
  else b.add('goal.achieved', { goal: goal as unknown as JsonObject, proof: proof as unknown as JsonObject }, g);
  o.after?.(b);
  const fp = o.evidenceFingerprint === null ? undefined : (o.evidenceFingerprint ?? 'fp1');
  const evidence = [rec('v1', body(CHECK.command, fp)), rec(criterionEvidenceKey(RUN, 'db', 'fp1'), body('node db.js', 'fp1', { criterionId: 'db' }))];
  return { events: b.list, evidence, hash: h, contract: c, proof };
}

function chained(list: TeceraEvent[]): Array<TeceraEvent & { seq: number; hash: string }> {
  let prev = GENESIS_HASH;
  return list.map((e, n) => {
    const hash = chainHash(prev, e);
    prev = hash;
    return { ...e, seq: n + 1, hash };
  });
}

describe('criteria sign-off (D8)', () => {
  it('acceptCriteriaActionHash binds goal, run and contract hash; signoffTrace satisfies the approval trace rule', () => {
    const a = acceptCriteriaActionHash({ goalId: 'g', runId: 'r', contractHash: 'h' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(acceptCriteriaActionHash({ goalId: 'g', runId: 'r', contractHash: 'h' })).toBe(a);
    for (const other of [{ goalId: 'g2', runId: 'r', contractHash: 'h' }, { goalId: 'g', runId: 'r2', contractHash: 'h' }, { goalId: 'g', runId: 'r', contractHash: 'h2' }]) expect(acceptCriteriaActionHash(other)).not.toBe(a);
    expect(() => event('approval.requested', { id: 'a', at: 1, actor: sys, payload: {}, trace: signoffTrace('g') })).not.toThrow();
    expect(signoffTrace('g')).toEqual({ goalId: 'g', intentionId: 'signoff:g', stepId: 'accept_criteria' });
  });

  it('a drafted contract awaits sign-off; an audited, consumed human grant bound to its hash accepts it', () => {
    const b = builder();
    const c = contract();
    const h = contractHash(c);
    b.add('criteria.drafted', payloadOf('criteria.drafted', { contract: c, hash: h, needs: [], source: 'planner' }), g);
    expect(acceptedContractOf(b.list, 'g')).toMatchObject({ state: 'drafted', current: h });
    const rid = signOff(b, h);
    b.add('criteria.accepted', payloadOf('criteria.accepted', { hash: h, via: 'approval', requestId: rid }), g);
    const v = acceptedContractOf(b.list, 'g');
    expect(v.state).toBe('accepted');
    expect(v.accepted).toMatchObject({ hash: h, via: 'approval', origin: 'drafted', approver: ana, requestId: 'so1' });
    expect(v.problems).toEqual([]);
  });

  it.each([
    ['no approval at all (forged acceptance)', (b: ReturnType<typeof builder>, h: string) => b.add('criteria.accepted', { hash: h, via: 'approval' }, g), /names no approval/],
    ['the requester approves its own contract', (b: ReturnType<typeof builder>, h: string) => {
      const rid = signOff(b, h, { requester: ana });
      b.add('criteria.accepted', { hash: h, via: 'approval', requestId: rid }, g);
    }, /human other than the requester/],
    ['an agent grant', (b: ReturnType<typeof builder>, h: string) => {
      const rid = signOff(b, h, { approver: agent });
      b.add('criteria.accepted', { hash: h, via: 'approval', requestId: rid }, g);
    }, /human other than the requester/],
    ['a grant bound to another contract', (b: ReturnType<typeof builder>, h: string) => {
      const rid = signOff(b, h, { boundTo: 'other-hash' });
      b.add('criteria.accepted', { hash: h, via: 'approval', requestId: rid }, g);
    }, /not bound to contract/],
    ['a grant never consumed', (b: ReturnType<typeof builder>, h: string) => {
      const rid = signOff(b, h, { consume: false });
      b.add('criteria.accepted', { hash: h, via: 'approval', requestId: rid }, g);
    }, /not consumed/],
    ['an acceptance of a hash that is not the current draft', (b: ReturnType<typeof builder>) => b.add('criteria.accepted', { hash: 'nope', via: 'approval', requestId: 'x' }, g), /not the current contract/],
    ['an agent claiming a goal-file acceptance', (b: ReturnType<typeof builder>, h: string) => b.add('criteria.accepted', { hash: h, via: 'goal-file' }, g, agent), /agent cannot accept/],
    ['a goal-file acceptance for a goal adopted without that contract', (b: ReturnType<typeof builder>, h: string) => b.add('criteria.accepted', { hash: h, via: 'goal-file' }, g), /not adopted with contract/],
  ])('refuses: %s', (_name, act, why) => {
    const b = builder();
    const c = contract();
    const h = contractHash(c);
    b.add('criteria.drafted', { contract: c as unknown as JsonObject, hash: h, needs: [], source: 'planner' }, g);
    act(b, h);
    const v = acceptedContractOf(b.list, 'g');
    expect(v.state).toBe('drafted');
    expect(v.accepted).toBeUndefined();
    expect(v.problems.join(' ')).toMatch(why);
  });

  it('one approval accepts one contract only', () => {
    const b = builder();
    const c = contract();
    const h = contractHash(c);
    b.add('criteria.drafted', payloadOf('criteria.drafted', { contract: c, hash: h, needs: [], source: 'planner' }), g);
    const rid = signOff(b, h);
    b.add('criteria.accepted', { hash: h, via: 'approval', requestId: rid }, g);
    const c2 = contract({ assumptions: ['x'] });
    b.add('criteria.amended', payloadOf('criteria.amended', { from: h, to: contractHash(c2), contract: c2, reason: 'r' }), g);
    b.add('criteria.accepted', { hash: contractHash(c2), via: 'approval', requestId: rid }, g);
    expect(acceptedContractOf(b.list, 'g')).toMatchObject({ state: 'stale' });
    expect(acceptedContractOf(b.list, 'g').problems.join(' ')).toMatch(/already accepted a contract/);
  });

  it('an amendment after acceptance makes it stale until the new hash is signed off', () => {
    const b = builder();
    const c = contract();
    const h = contractHash(c);
    b.add('criteria.drafted', payloadOf('criteria.drafted', { contract: c, hash: h, needs: [], source: 'planner' }), g);
    b.add('criteria.accepted', { hash: h, via: 'approval', requestId: signOff(b, h) }, g);
    const c2 = contract({ outOfScope: ['clustering'] });
    const h2 = contractHash(c2);
    b.add('criteria.amended', payloadOf('criteria.amended', { from: h, to: h2, contract: c2, reason: 'scope' }), g);
    const stale = acceptedContractOf(b.list, 'g');
    expect(stale).toMatchObject({ state: 'stale', current: h2, staleAcceptance: { hash: h } });
    expect(stale.accepted).toBeUndefined();
    b.add('criteria.accepted', { hash: h2, via: 'approval', requestId: signOff(b, h2, { rid: 'so2' }) }, g);
    expect(acceptedContractOf(b.list, 'g')).toMatchObject({ state: 'accepted', accepted: { hash: h2, origin: 'amended' } });
  });

  it('a draft whose hash does not match its contract, or that names another goal, is ignored', () => {
    const b = builder();
    const c = contract();
    b.add('criteria.drafted', { contract: c as unknown as JsonObject, hash: 'forged', needs: [], source: 'planner' }, g);
    const other = contract({ goalId: 'g2' });
    b.add('criteria.drafted', { contract: other as unknown as JsonObject, hash: contractHash(other), needs: [], source: 'planner' }, g);
    const v = acceptedContractOf(b.list, 'g');
    expect(v.state).toBe('none');
    expect(v.problems).toHaveLength(2);
  });

  it('goal-file route: accepted when the goal was adopted with that hash; refused when sign-off is required', () => {
    const s = scenario({ contract: true, goalFile: true });
    expect(acceptedContractOf(s.events, 'g')).toMatchObject({ state: 'accepted', accepted: { via: 'goal-file' } });
    expect(acceptedContractOf(s.events, 'g', { requireApproval: true }).state).toBe('drafted');
  });
});

describe('capability inventory (D9, D10)', () => {
  it('probes, provisioning, mocks and releases fold into one row per capability', () => {
    const b = builder();
    b.add('capability.probed', payloadOf('capability.probed', { capability: { id: 'git', kind: 'git-remote', state: 'available', probe: { command: 'git ls-remote origin', exitCode: 0 } } }));
    b.add('capability.probed', payloadOf('capability.probed', { capability: { id: 'db', kind: 'sqlite', state: 'missing' } }));
    b.add('capability.missing', payloadOf('capability.missing', { capability: { id: 'mail', kind: 'smtp', state: 'missing' }, criteria: ['welcome'], resolution: 'mock' }), g);
    b.add('resource.provisioned', payloadOf('resource.provisioned', { resource: resource() }), g);
    b.add('capability.mocked', payloadOf('capability.mocked', { capability: 'mail', kind: 'smtp', tool: 'mail', mockId: 'm1', reason: 'not provisionable' }), g);
    const inv = capabilityInventoryOf(b.list, { runId: RUN });
    expect(inv.byId).toMatchObject({ git: { state: 'available', probe: { exitCode: 0 } }, db: { state: 'provisioned', resourceId: 'res1' }, mail: { state: 'mocked', resourceId: 'm1' } });
    expect(fidelityFor(inv, ['git'])).toBe('real');
    expect(fidelityFor(inv, ['git', 'db'])).toBe('provisioned');
    expect(fidelityFor(inv, ['db', 'mail'])).toBe('mocked');
    expect(fidelityFor(inv, ['nothing'])).toBeNull();
    expect(fidelityFor(inv, undefined)).toBe('real');
    b.add('resource.released', payloadOf('resource.released', { resourceId: 'res1', teardownExit: 0, reason: 'expired' }));
    expect(capabilityInventoryOf(b.list).byId.db!.state).toBe('missing');
  });

  it('a mock never stands in for an available or provisioned capability', () => {
    const b = builder();
    b.add('capability.probed', { capability: { id: 'git', kind: 'git-remote', state: 'available', probe: { command: 'git ls-remote origin', exitCode: 0 } } });
    b.add('resource.provisioned', { resource: resource() as unknown as JsonObject }, g);
    b.add('capability.mocked', { capability: 'git', kind: 'git-remote', tool: 'git', mockId: 'm' }, g);
    b.add('capability.mocked', { capability: 'db', kind: 'sqlite', tool: 'db', mockId: 'm2' }, g);
    const inv = capabilityInventoryOf(b.list);
    expect(inv.byId.git!.state).toBe('available');
    expect(inv.byId.db!.state).toBe('provisioned');
    expect(inv.problems).toHaveLength(2);
  });

  it('mockRegistrationProblem refuses available, provisioned and non-mockable capabilities; simulated provenance is tagged', () => {
    const decl: MockToolDeclaration = { capability: 'mail', kind: 'smtp', tool: 'mail', methods: ['send'], schema: {}, mockId: 'm1', reason: 'gap ladder: mock' };
    expect(mockRegistrationProblem(decl, { id: 'mail', kind: 'smtp', state: 'missing' })).toBeNull();
    expect(mockRegistrationProblem(decl, undefined)).toBeNull();
    expect(mockRegistrationProblem(decl, { id: 'mail', kind: 'smtp', state: 'available' })).toMatch(/available/);
    expect(mockRegistrationProblem(decl, { id: 'mail', kind: 'smtp', state: 'provisioned' })).toMatch(/provisioned/);
    expect(mockRegistrationProblem(decl, undefined, { mockable: false })).toMatch(/not mockable/);
    expect(mockRegistrationProblem({ ...decl, methods: [] }, undefined)).toMatch(/no tool or methods/);
    const p = simulatedProvenance('mail', RUN);
    expect(p).toEqual({ src: 'simulated:mail', trust: 'untrusted', simulated: true, runId: RUN });
    expect(isSimulated(p)).toBe(true);
    expect(isSimulated({ ...p, simulated: undefined })).toBe(true);
    expect(isSimulated({ src: 'tool:read', trust: 'trusted' })).toBe(false);
    expect(isSimulated(undefined)).toBe(false);
  });
});

describe('provisioned resources are debts (D12)', () => {
  it('resourceProblem and locatorProblem refuse credentials, missing teardowns and anything outside the allowance', () => {
    expect(resourceProblem(resource(), ALLOW)).toBeNull();
    expect(resourceProblem(resource({ teardown: ' ' }))).toMatch(/no teardown/);
    expect(resourceProblem(resource({ expiresAt: 1000 }))).toMatch(/no expiry/);
    expect(resourceProblem(resource({ transfer: 'transferred' }))).toMatch(/not pending/);
    expect(resourceProblem({ ...resource(), provider: 'aws' })).toMatch(/not local/);
    expect(resourceProblem(resource({ kind: 'postgres' }), ALLOW)).toMatch(/outside the allowance/);
    expect(resourceProblem(resource({ expiresAt: 1000 + 7_200_000 }), ALLOW)).toMatch(/longer than the allowance/);
    expect(resourceProblem(resource(), { ...ALLOW, scope: 'none' })).toMatch(/nothing may be provisioned/);
    for (const bad of ['postgres://admin:hunter22@127.0.0.1/db', 'http://127.0.0.1:9/x?api_key=abc', 'http://127.0.0.1:9/?token=1', 'Bearer abcdefgh', '/tmp/TECERA_CANARY_X', 'ghp_abcdefghijkl1234']) {
      const why = locatorProblem(bad);
      expect(why, bad).not.toBeNull();
      expect(why).not.toContain(bad);
      expect(resourceProblem(resource({ locator: bad }))).not.toContain(bad);
    }
    expect(locatorProblem('http://127.0.0.1:8123/')).toBeNull();
    expect(locatorProblem('/tmp/tecera/remote.git')).toBeNull();
    expect(locatorProblem('/tmp/x', (v) => v.includes('/tmp'))).toMatch(/known secret/);
  });

  it('the registry lists pending debts; only a human transfers, never an agent releases, and end states are final', () => {
    const b = builder();
    b.add('resource.provisioned', payloadOf('resource.provisioned', { resource: resource() }), g);
    b.add('resource.provisioned', payloadOf('resource.provisioned', { resource: resource({ id: 'res2', kind: 'git-remote', capability: 'remote', locator: '/tmp/r.git', teardown: 'rm -rf /tmp/r.git', expiresAt: 2000 }) }), g);
    b.add('resource.provisioned', payloadOf('resource.provisioned', { resource: resource({ id: 'bad', locator: 'postgres://u:p@localhost/x' }) }), g);
    let reg = resourceRegistryOf(b.list);
    expect(reg.pending.map((r) => r.id)).toEqual(['res1', 'res2']);
    expect(reg.byId.res1).toMatchObject({ goalId: 'g', runId: RUN, transfer: 'pending' });
    expect(reg.problems.join(' ')).toMatch(/userinfo/);
    expect(reg.problems.join(' ')).not.toContain('u:p@');
    expect(expiredResources(reg, 1500).map((r) => r.id)).toEqual([]);
    expect(expiredResources(reg, 2000).map((r) => r.id)).toEqual(['res2']);

    b.add('resource.transferred', payloadOf('resource.transferred', { resourceId: 'res1', to: ana }), {}, agent);
    b.add('resource.released', payloadOf('resource.released', { resourceId: 'res2', teardownExit: 0, reason: 'x' }), {}, agent);
    reg = resourceRegistryOf(b.list);
    expect(reg.pending.map((r) => r.id)).toEqual(['res1', 'res2']);
    expect(reg.problems.join(' ')).toMatch(/only a human/);
    expect(reg.problems.join(' ')).toMatch(/agent cannot release/);

    b.add('resource.transferred', payloadOf('resource.transferred', { resourceId: 'res1', to: ana }), {}, ana);
    b.add('resource.released', payloadOf('resource.released', { resourceId: 'res2', teardownExit: 0, reason: 'expired' }), {}, sys);
    b.add('resource.released', payloadOf('resource.released', { resourceId: 'res1', teardownExit: 0, reason: 'x' }), {}, sys);
    reg = resourceRegistryOf(b.list);
    expect(reg.pending).toEqual([]);
    expect(reg.byId).toMatchObject({ res1: { transfer: 'transferred' }, res2: { transfer: 'released' } });
    expect(reg.problems.join(' ')).toMatch(/res1 is already transferred/);
  });

  it('more resources than the allowance is a problem, and every one stays listed', () => {
    const b = builder();
    for (let n = 0; n < 5; n++) b.add('resource.provisioned', { resource: resource({ id: `r${n}` }) as unknown as JsonObject }, g);
    const reg = resourceRegistryOf(b.list, { allowance: ALLOW });
    expect(reg.pending).toHaveLength(5);
    expect(reg.problems.join(' ')).toMatch(/more than 4 resources/);
  });
});

describe('goal.provisional (D11)', () => {
  const mockedProof: AchievementProof = { command: CHECK.command, exitCode: 0, fingerprint: 'fp', evidenceKey: 'v', verifiedAt: 1, fidelity: 'mocked' };
  const goal: AchievementGoal = { id: 'g', statement: 's', check: CHECK, commitment: 'single-minded', status: 'open', evidence: [] };

  it('a mocked proof is provisional, never achieved; a real one is never provisional', () => {
    expect(achievementProofProblem(mockedProof)).toMatch(/mocked/);
    expect(provisionalProofProblem(mockedProof, CHECK)).toBeNull();
    expect(provisionalProofProblem({ ...mockedProof, fidelity: 'real' })).toMatch(/rests on no mock/);
    expect(provisionalProofProblem({ ...mockedProof, exitCode: 1 })).toMatch(/exit/);
  });

  it('markProvisional keeps the goal open with a marker; any transition clears it; achieved goals cannot become provisional', () => {
    const p = markProvisional(goal, mockedProof);
    expect(p).toMatchObject({ status: 'open', provisional: true });
    expect(() => markProvisional(goal, { ...mockedProof, fidelity: 'real' })).toThrow(IllegalTransition);
    const achieved = transitionGoal(p, 'achieved', ['ev'], { ...mockedProof, fidelity: 'real' });
    expect(achieved.provisional).toBeUndefined();
    expect(() => markProvisional(achieved, mockedProof)).toThrow(IllegalTransition);
  });

  it('payloadOf type-checks a payload and drops undefined fields', () => {
    expect(payloadOf('criteria.accepted', { hash: 'h', via: 'goal-file', requestId: undefined })).toEqual({ hash: 'h', via: 'goal-file' });
  });
});

describe('provenAchievement: the single-source "proven achieved" decision', () => {
  it('single-check path: a goal.achieved backed by this run\'s verify is proven', () => {
    const s = scenario();
    const v = provenAchievement(s.events, s.evidence, { runId: RUN, goalId: 'g' });
    expect(v).toMatchObject({ achieved: true, provisional: false, why: null, proof: { evidenceKey: 'v1' } });
    expect(provenRun(s.events, s.evidence, RUN)).toMatchObject({ achieved: true, why: null });
  });

  it('a forged goal.achieved does not prove anything', () => {
    // Evidence without a fingerprint (sprint 5 runtime finding 1).
    expect(provenAchievement(scenario({ evidenceFingerprint: null }).events, scenario().evidence.map((r) => (r.key === 'v1' ? rec('v1', body(CHECK.command, undefined)) : r)), { runId: RUN, goalId: 'g' }).why).toMatch(/no candidate fingerprint/);
    // Real verify evidence, but a later verify of the goal failed: the forged event points at the stale pass.
    const later = scenario({ after: (b) => b.add('verify.failed', { evidenceKey: 'v2', fingerprint: 'fp2', exitCode: 1 }, it1('verify')) });
    const forged = [...later.events, event('goal.achieved', { id: 'forged', at: 99, actor: sys, payload: { proof: later.proof as unknown as JsonObject }, trace: g, runId: RUN })];
    expect(provenAchievement(forged, later.evidence, { runId: RUN, goalId: 'g' }).why).toMatch(/latest verify before goal.achieved failed/);
    // A proof naming evidence of another run.
    const other = scenario();
    expect(provenAchievement(other.events, [rec('v1', body(CHECK.command, 'fp1'), 'r0')], { runId: RUN, goalId: 'g' }).why).toMatch(/belongs to run r0/);
    // No verify.passed for the goal at all.
    const noVerify = scenario();
    const stripped = noVerify.events.filter((e) => e.kind !== 'verify.passed');
    expect(provenAchievement(stripped, noVerify.evidence, { runId: RUN, goalId: 'g' }).why).toMatch(/no verify ran/);
    // A goal.achieved carrying its own (weaker) check is judged against the adopted check.
    const weak = scenario();
    const swapped = weak.events.map((e) => (e.kind === 'goal.achieved' ? { ...e, payload: { goal: { id: 'g', check: { command: 'true', timeoutSec: 1 } }, proof: { ...weak.proof, command: 'true' } as unknown as JsonObject } } : e));
    expect(provenAchievement(swapped, weak.evidence, { runId: RUN, goalId: 'g' }).why).toMatch(/another command/);
    // Tampered evidence body.
    const t = scenario();
    const tampered = t.evidence.map((r) => (r.key === 'v1' ? { ...r, body: { ...(r.body as JsonObject), extra: 1 } } : r));
    expect(provenAchievement(t.events, tampered, { runId: RUN, goalId: 'g' }).why).toMatch(/digest/);
  });

  it('later work, demotion, provisional marking or a criteria change after goal.achieved revokes it', () => {
    for (const [kind, payload, trace] of [
      ['step.started', {}, { ...it1('w2') }],
      ['intention.pushed', {}, it1()],
      ['goal.demoted', {}, g],
      ['criteria.amended', {}, g],
      ['verify.passed', { evidenceKey: 'v9', fingerprint: 'fp9' }, it1('verify')],
    ] as const) {
      const s = scenario({ after: (b) => b.add(kind, payload, trace) });
      const v = provenAchievement(s.events, s.evidence, { runId: RUN, goalId: 'g' });
      expect(v.achieved, kind).toBe(false);
      expect(v.why, kind).toMatch(/after goal.achieved/);
    }
    const same = scenario({ after: (b) => b.add('verify.passed', { evidenceKey: 'v1', fingerprint: 'fp1' }, it1('verify')) });
    expect(provenAchievement(same.events, same.evidence, { runId: RUN, goalId: 'g' }).achieved).toBe(true);
  });

  it('with a contract: accepted, matching hash, every criterion proven within the inventory', () => {
    const s = scenario({ contract: true });
    const v = provenAchievement(s.events, s.evidence, { runId: RUN, goalId: 'g' });
    expect(v.why).toBeNull();
    expect(v.achieved).toBe(true);
    expect(provenAchievement(scenario({ contract: true, goalFile: true }).events, s.evidence, { runId: RUN, goalId: 'g' }).achieved).toBe(true);
  });

  it('with a contract: a stronger fidelity than the inventory allows, a stale or other contract, a requester-judged human criterion all fail', () => {
    const cases: Array<[Opts, RegExp]> = [
      [{ contract: true, dbFidelity: 'real' }, /claims real, the inventory allows at best provisioned/],
      [{ contract: true, proofHash: 'h-other' }, /proof is for contract h-other/],
      [{ contract: true, amendAfterAccept: true }, /stale, not accepted/],
      [{ contract: true, docsByRequester: true }, /granted by its requester/],
      [{ contract: true, goalFile: true, freshDraftOverGoalFile: true }, /not the goal file's/],
    ];
    for (const [o, why] of cases) {
      const s = scenario(o);
      const v = provenAchievement(s.events, s.evidence, { runId: RUN, goalId: 'g' });
      expect(v.achieved, JSON.stringify(o)).toBe(false);
      expect(v.why, JSON.stringify(o)).toMatch(why);
    }
    const s = scenario({ contract: true });
    const noDbEvidence = s.evidence.filter((r) => r.key === 'v1');
    expect(provenAchievement(s.events, noDbEvidence, { runId: RUN, goalId: 'g' }).why).toMatch(/criterion db: verify evidence .* is not in the ledger/);
    const goalFile = scenario({ contract: true, goalFile: true });
    expect(provenAchievement(goalFile.events, goalFile.evidence, { runId: RUN, goalId: 'g', requireApproval: true }).why).toMatch(/drafted, not accepted/);
    // A goal adopted with criteria but no criteria.* events was never accepted.
    const bare = scenario({ goalFile: true });
    expect(provenAchievement(bare.events, bare.evidence, { runId: RUN, goalId: 'g' }).why).toMatch(/not drafted, not accepted/);
  });

  it('the fidelity the verify gate recorded for a criterion is a ceiling: a later relabelling of its capability never raises the proof', () => {
    const s = scenario({ contract: true });
    // the db criterion ran on a mock (its evidence says so); a later inventory claiming 'provisioned' changes nothing
    const mockedAtVerify = s.evidence.map((r) => (r.key === criterionEvidenceKey(RUN, 'db', 'fp1') ? rec(r.key, body('node db.js', 'fp1', { criterionId: 'db', fidelity: 'mocked' })) : r));
    const v = provenAchievement(s.events, mockedAtVerify, { runId: RUN, goalId: 'g' });
    expect(v.achieved).toBe(false);
    expect(v.why).toMatch(/criterion db claims provisioned, its verify evidence recorded mocked/);
    // the same recorded fidelity, or a weaker claim, stands
    const asRecorded = s.evidence.map((r) => (r.key === criterionEvidenceKey(RUN, 'db', 'fp1') ? rec(r.key, body('node db.js', 'fp1', { criterionId: 'db', fidelity: 'provisioned' })) : r));
    expect(provenAchievement(s.events, asRecorded, { runId: RUN, goalId: 'g' }).achieved).toBe(true);
  });

  it('criteria events the projection ignores still make the goal contractual: a malformed draft never falls back to the single-check path', () => {
    const plain = scenario();
    expect(provenAchievement(plain.events, plain.evidence, { runId: RUN, goalId: 'g' }).achieved).toBe(true);
    const at = plain.events.findIndex((e) => e.kind === 'intention.pushed');
    const bad = event('criteria.drafted', { id: 'bad-draft', at: 2, actor: sys, runId: RUN, trace: g, payload: { contract: { goalId: 'g', criteria: [] }, hash: 'nope', needs: [], source: 'planner' } as unknown as JsonObject });
    const evs = [...plain.events.slice(0, at), bad, ...plain.events.slice(at)];
    const v = provenAchievement(evs, plain.evidence, { runId: RUN, goalId: 'g' });
    expect(v.achieved).toBe(false);
    expect(v.why).toMatch(/not drafted, not accepted/);
  });

  it('a mocked criterion: goal.provisional, not achieved, and the run reports provisional', () => {
    const s = scenario({ contract: true, mockDb: true });
    const v = provenAchievement(s.events, s.evidence, { runId: RUN, goalId: 'g' });
    expect(v).toMatchObject({ achieved: false, provisional: true });
    expect(provenRun(s.events, s.evidence, RUN)).toMatchObject({ achieved: false, provisional: true });
    // Even with a goal.achieved forged on top of the mocked proof.
    const forged = [...s.events, event('goal.achieved', { id: 'f', at: 99, actor: sys, payload: { proof: s.proof as unknown as JsonObject }, trace: g, runId: RUN })];
    expect(provenAchievement(forged, s.evidence, { runId: RUN, goalId: 'g' }).why).toMatch(/mocked/);
    expect(achievedProofOf(s.events, RUN)).toBeNull();
  });

  it('ledgerProvenRun reads the run and only the evidence its proofs name', async () => {
    const s = scenario({ contract: true });
    const asked: string[] = [];
    const ledger = {
      async *events(f?: { runId?: string }) {
        let seq = 0;
        for (const e of s.events) if (!f?.runId || e.runId === f.runId) yield { ...e, seq: ++seq, hash: 'h' };
      },
      async getEvidence(k: string) {
        asked.push(k);
        return s.evidence.find((r) => r.key === k) ?? null;
      },
      async verifyChain() {
        return { ok: true, length: s.events.length };
      },
    } as unknown as Ledger;
    await expect(ledgerProvenRun(ledger, RUN)).resolves.toMatchObject({ achieved: true });
    expect(asked.sort()).toEqual(['v1', criterionEvidenceKey(RUN, 'db', 'fp1')].sort());
  });
});

describe('deriveGoalStatus delegates to provenAchievement', () => {
  it('goal.provisional records open with a marker and agrees; a revoked goal.achieved derives open', () => {
    const p = scenario({ contract: true, mockDb: true });
    const d = deriveGoalStatus(chained(p.events), p.evidence, { requireCommit: false, requirePr: false });
    expect(d.goals.g).toMatchObject({ status: 'open', recorded: 'open', agrees: true, provisional: true });

    const ok = scenario({ contract: true });
    expect(deriveGoalStatus(chained(ok.events), ok.evidence, { requireCommit: false, requirePr: false }).goals.g!.status).toBe('achieved');
    const revoked = scenario({ contract: true, after: (b) => b.add('step.started', {}, it1('w2')) });
    const r = deriveGoalStatus(chained(revoked.events), revoked.evidence, { requireCommit: false, requirePr: false }).goals.g!;
    expect(r.status).toBe('open');
    expect(r.reasons.join(' ')).toMatch(/step.started after goal.achieved/);
    const stronger = scenario({ contract: true, dbFidelity: 'real' });
    expect(deriveGoalStatus(chained(stronger.events), stronger.evidence, { requireCommit: false, requirePr: false }).goals.g!.status).toBe('open');
  });
});

describe('kernel repair: review findings', () => {
  const prove = (s: ReturnType<typeof scenario>, extra: Partial<Parameters<typeof provenAchievement>[2]> = {}) => provenAchievement(s.events, s.evidence, { runId: RUN, goalId: 'g', ...extra });

  it('locatorProblem finds credentials anywhere: no scheme, no prefix, leading space, encoded, control characters', () => {
    for (const bad of [
      'password=hunter2',
      '/tmp/x password=hunter2',
      '//user:pass@127.0.0.1/db',
      '//ghtoken123@127.0.0.1/repo.git',
      ' https://user:pass@127.0.0.1/db',
      'user:pass@localhost:5432',
      'http://127.0.0.1:9/x%3Ftoken%3Dabc',
      'http%3A%2F%2Fu%3Ap%40127.0.0.1',
      '/tmp/x\nAuthorization',
      'sk-abcdefgh12345678',
      '/tmp/tecera_canary_x',
    ]) {
      const why = locatorProblem(bad);
      expect(why, JSON.stringify(bad)).not.toBeNull();
      expect(why).not.toContain(bad.trim());
    }
    for (const ok of ['http://127.0.0.1:8123/', '/tmp/tecera/remote.git', '/tmp/tecera-res/res1.sqlite', 'http://localhost:5000/api/v1', '/tmp/task-abcdefgh12345']) expect(locatorProblem(ok), ok).toBeNull();
    // an encoded known secret is found too
    expect(locatorProblem('/tmp/a%2Fs3cr3t', (v) => v.includes('/s3cr3t'))).toMatch(/known secret/);
  });

  it('the registry and the inventory refuse a locator carrying a known secret when given the secrets', () => {
    const b = builder();
    b.add('resource.provisioned', payloadOf('resource.provisioned', { resource: resource({ locator: '/tmp/s3cr3t.sqlite' }) }), g);
    const secrets = (v: string) => v.includes('s3cr3t');
    expect(resourceRegistryOf(b.list).pending).toHaveLength(1);
    const reg = resourceRegistryOf(b.list, { secrets });
    expect(reg.pending).toEqual([]);
    expect(reg.problems.join(' ')).toMatch(/known secret/);
    expect(reg.problems.join(' ')).not.toContain('s3cr3t');
    expect(capabilityInventoryOf(b.list, { secrets }).byId.db).toBeUndefined();
  });

  it('the inventory counts a resource as provisioned only when resourceProblem accepts it, inside the allowance and maxResources', () => {
    const b = builder();
    b.add('resource.provisioned', { resource: resource({ teardown: '' }) as unknown as JsonObject }, g);
    b.add('resource.provisioned', { resource: resource({ id: 'r2', capability: 'cache', locator: 'redis://u:p@127.0.0.1' }) as unknown as JsonObject }, g);
    const inv = capabilityInventoryOf(b.list);
    expect(inv.byId.db).toBeUndefined();
    expect(inv.byId.cache).toBeUndefined();
    expect(inv.problems).toHaveLength(2);
    expect(inv.problems.join(' ')).not.toContain('u:p@');
    // outside the allowance's kinds: not provisioned
    const k = builder();
    k.add('resource.provisioned', payloadOf('resource.provisioned', { resource: resource() }), g);
    expect(capabilityInventoryOf(k.list).byId.db!.state).toBe('provisioned');
    expect(capabilityInventoryOf(k.list, { allowance: { ...ALLOW, kinds: ['tmpdir'] } }).byId.db).toBeUndefined();
    // past maxResources: not provisioned
    const m = builder();
    for (let n = 0; n < 3; n++) m.add('resource.provisioned', payloadOf('resource.provisioned', { resource: resource({ id: `r${n}`, capability: `c${n}` }) }), g);
    const capped = capabilityInventoryOf(m.list, { allowance: { ...ALLOW, maxResources: 2 } });
    expect(Object.keys(capped.byId).sort()).toEqual(['c0', 'c1']);
    // a duplicate id never counts twice
    const d = builder();
    d.add('resource.provisioned', payloadOf('resource.provisioned', { resource: resource() }), g);
    d.add('resource.provisioned', payloadOf('resource.provisioned', { resource: resource({ capability: 'other' }) }), g);
    expect(capabilityInventoryOf(d.list).byId.other).toBeUndefined();
  });

  it('provenAchievement: a provisioned criterion fails when its resource is outside the allowance', () => {
    const s = scenario({ contract: true });
    expect(prove(s, { allowance: ALLOW }).achieved).toBe(true);
    expect(prove(s, { allowance: { ...ALLOW, kinds: ['tmpdir'] } }).why).toMatch(/criterion db requires a capability the run lacks/);
  });

  it('a probe claims available only with a probe command that exited 0', () => {
    const b = builder();
    b.add('capability.probed', { capability: { id: 'a', kind: 'git-remote', state: 'available' } });
    b.add('capability.probed', { capability: { id: 'b', kind: 'git-remote', state: 'available', probe: { command: 'git ls-remote', exitCode: 2 } } });
    b.add('capability.probed', { capability: { id: 'c', kind: 'git-remote', state: 'available', probe: { command: 'git ls-remote', exitCode: 0 } } });
    const inv = capabilityInventoryOf(b.list);
    expect(inv.byId.a!.state).toBe('missing');
    expect(inv.byId.b!.state).toBe('missing');
    expect(inv.byId.c!.state).toBe('available');
    expect(inv.problems).toHaveLength(2);
  });

  it.each<[string, AnswerOpts, RegExp]>([
    ['granted before it was requested', { grantFirst: true }, /never granted after its request/],
    ['a grant whose session differs from the request (unaudited)', { grantSession: 'other' }, /session differs/],
    ['an approval bound to another criterion', { criterionId: 'tests' }, /not an answer_criterion approval bound/],
    ['an approval bound to another candidate', { fingerprint: 'fp0' }, /not an answer_criterion approval bound/],
    ['never consumed', { consume: false }, /not consumed before goal.achieved/],
    ['consumed by an agent', { consumer: agent }, /not consumed before goal.achieved/],
    ['a request with no actor', { requester: null }, /names no requester/],
  ])('a human criterion proof is refused when %s', (_n, answerOpts, why) => {
    const v = prove(scenario({ contract: true, answer: answerOpts }));
    expect(v.achieved).toBe(false);
    expect(v.why).toMatch(why);
  });

  it('the PR approval (or any other approval) cannot stand in for a human criterion answer', () => {
    const s = scenario({ contract: true, skipAnswer: true });
    const forged = s.events.map((e) => (e.kind === 'goal.achieved' ? { ...e, payload: { ...e.payload, proof: { ...s.proof, criteria: s.proof.criteria!.map((c) => (c.criterionId === 'docs' ? { ...c, evidenceKey: 'pr1' } : c)) } as unknown as JsonObject } } : e));
    expect(provenAchievement(forged, s.evidence, { runId: RUN, goalId: 'g' }).why).toMatch(/approval pr1 is not an answer_criterion approval/);
  });

  it('an answer given after goal.achieved does not prove it', () => {
    const s = scenario({ contract: true, skipAnswer: true, after: (b) => answer(b, contractHash(contract())) });
    expect(prove(s).why).toMatch(/never requested for the goal before goal.achieved/);
  });

  it('verify evidence without a digest, or simulated, proves nothing', () => {
    const s = scenario();
    const noDigest = s.evidence.map((r) => (r.key === 'v1' ? ({ ...r, digest: undefined } as unknown as EvidenceRecord) : r));
    expect(provenAchievement(s.events, noDigest, { runId: RUN, goalId: 'g' }).why).toMatch(/does not match its digest/);
    const asMap = new Map(noDigest.map((r) => [r.key, r]));
    expect(provenAchievement(s.events, asMap, { runId: RUN, goalId: 'g' }).achieved).toBe(false);
    const sim = s.evidence.map((r) => (r.key === 'v1' ? rec('v1', body(CHECK.command, 'fp1', { provenance: simulatedProvenance('db', RUN) as unknown as JsonObject })) : r));
    expect(provenAchievement(s.events, sim, { runId: RUN, goalId: 'g' }).why).toMatch(/is simulated/);
  });

  it('a broken hash chain proves nothing: provenAchievement with the verdict, ledgerProvenRun always fetches it', async () => {
    const s = scenario({ contract: true });
    expect(prove(s, { chain: { ok: true, length: 1 } }).achieved).toBe(true);
    expect(prove(s, { chain: { ok: false, brokenAtSeq: 3 } }).why).toMatch(/hash chain is broken at seq 3/);
    expect(provenRun(s.events, s.evidence, RUN, { chain: { ok: false, brokenAtSeq: 3, brokenEvidenceKey: 'v1' } }).achieved).toBe(false);
    const ledger = (verdict: unknown) =>
      ({
        async *events() {
          let seq = 0;
          for (const e of s.events) yield { ...e, seq: ++seq, hash: 'h' };
        },
        async getEvidence(k: string) {
          return s.evidence.find((r) => r.key === k) ?? null;
        },
        ...(verdict ? { verifyChain: async () => verdict } : {}),
      }) as unknown as Ledger;
    await expect(ledgerProvenRun(ledger({ ok: true, length: 1 }), RUN)).resolves.toMatchObject({ achieved: true });
    const broken = await ledgerProvenRun(ledger({ ok: false, brokenAtSeq: 2 }), RUN);
    expect(broken.achieved).toBe(false);
    expect(broken.why).toMatch(/hash chain is broken/);
    await expect(ledgerProvenRun(ledger(null), RUN)).rejects.toThrow(/verifyChain/);
  });

  it('ledger order wins over caller order even when a candidate without a seq is appended', () => {
    const s = scenario({ after: (b) => b.add('step.started', {}, it1('w2')) });
    const seqd = s.events.map((e, n) => ({ ...e, seq: n + 1 }));
    // caller puts the later step.started first; the seq-less candidate goal.achieved comes last
    const last = seqd[seqd.length - 1]!;
    const shuffled = [last, ...seqd.slice(0, -1)];
    expect(provenAchievement(shuffled, s.evidence, { runId: RUN, goalId: 'g' }).why).toMatch(/step.started after goal.achieved/);
    const withCandidate = [last, ...seqd.slice(0, -1), event('goal.achieved', { id: 'cand', at: 99, actor: sys, payload: { proof: s.proof as unknown as JsonObject }, trace: g, runId: RUN })];
    // the candidate sorts after every ledger event, so it is the latest goal.achieved and nothing follows it
    expect(provenAchievement(withCandidate, s.evidence, { runId: RUN, goalId: 'g' }).achievedEventId).toBe('cand');
    // one seq-less event in the list must not hand ordering back to the caller
    const mixed = [last, ...seqd.slice(0, -1), event('belief.added', { id: 'b', at: 99, actor: sys, payload: { key: 'k', value: 1 }, trace: {}, runId: RUN })];
    expect(provenAchievement(mixed, s.evidence, { runId: RUN, goalId: 'g' }).why).toMatch(/step.started after goal.achieved/);
    const reversed = [...seqd].reverse().filter((e) => e.kind !== 'step.started');
    expect(provenAchievement(reversed, s.evidence, { runId: RUN, goalId: 'g' }).achieved).toBe(true);
  });

  it('sign-off: an actorless requester, or a consume by an agent or of another run, does not accept', () => {
    const base = () => {
      const b = builder();
      const c = contract();
      const h = contractHash(c);
      b.add('criteria.drafted', payloadOf('criteria.drafted', { contract: c, hash: h, needs: [], source: 'planner' }), g);
      return { b, h };
    };
    // actorless requester
    {
      const { b, h } = base();
      const rid = signOff(b, h);
      const req = b.list.find((e) => e.kind === 'approval.requested')!;
      delete (req as Partial<TeceraEvent>).actor;
      b.add('criteria.accepted', { hash: h, via: 'approval', requestId: rid }, g);
      expect(acceptedContractOf(b.list, 'g').problems.join(' ')).toMatch(/names no requester/);
    }
    for (const [name, mutate] of [
      ['agent', (e: TeceraEvent) => ({ ...e, actor: agent })],
      ['another run', (e: TeceraEvent) => ({ ...e, runId: 'r0' })],
      ['another session', (e: TeceraEvent) => ({ ...e, payload: { ...e.payload, sessionId: 'other' } })],
    ] as const) {
      const { b, h } = base();
      const rid = signOff(b, h);
      const n = b.list.findIndex((e) => e.kind === 'approval.consumed');
      b.list[n] = mutate(b.list[n]!);
      b.add('criteria.accepted', { hash: h, via: 'approval', requestId: rid }, g);
      const v = acceptedContractOf(b.list, 'g');
      expect(v.state, name).toBe('drafted');
      expect(v.problems.join(' '), name).toMatch(/not consumed/);
    }
  });

  it('goal-file acceptance needs a system or human actor', () => {
    const s = scenario({ contract: true, goalFile: true });
    const acc = s.events.findIndex((e) => e.kind === 'criteria.accepted');
    const actorless = s.events.map((e, n) => (n === acc ? ({ ...e, actor: undefined } as unknown as TeceraEvent) : e));
    const v = acceptedContractOf(actorless, 'g');
    expect(v.state).toBe('drafted');
    expect(v.problems.join(' ')).toMatch(/no system or human actor/);
  });

  it('a draft of another hash after acceptance makes the acceptance stale; a re-draft of the same hash does not', () => {
    const b = builder();
    const c = contract();
    const h = contractHash(c);
    b.add('criteria.drafted', payloadOf('criteria.drafted', { contract: c, hash: h, needs: [], source: 'planner' }), g);
    b.add('criteria.accepted', { hash: h, via: 'approval', requestId: signOff(b, h) }, g);
    b.add('criteria.drafted', payloadOf('criteria.drafted', { contract: c, hash: h, needs: [], source: 'planner' }), g);
    expect(acceptedContractOf(b.list, 'g')).toMatchObject({ state: 'accepted', accepted: { hash: h } });
    const c2 = contract({ assumptions: ['weaker'] });
    b.add('criteria.drafted', payloadOf('criteria.drafted', { contract: c2, hash: contractHash(c2), needs: [], source: 'planner' }), g);
    const v = acceptedContractOf(b.list, 'g');
    expect(v).toMatchObject({ state: 'stale', current: contractHash(c2), staleAcceptance: { hash: h } });
    expect(v.accepted).toBeUndefined();
  });

  it('resources past maxResources stay listed as debts and are named in overAllowance; an actorless release is refused', () => {
    const b = builder();
    for (let n = 0; n < 5; n++) b.add('resource.provisioned', { resource: resource({ id: `r${n}` }) as unknown as JsonObject }, g);
    const reg = resourceRegistryOf(b.list, { allowance: ALLOW });
    expect(reg.pending).toHaveLength(5);
    expect(reg.overAllowance).toEqual(['r4']);
    expect(resourceRegistryOf(b.list).overAllowance).toEqual([]);
    const rel = event('resource.released', { id: 'rel', at: 99, actor: sys, payload: payloadOf('resource.released', { resourceId: 'r0', teardownExit: 0, reason: 'x' }), trace: {}, runId: RUN });
    delete (rel as Partial<TeceraEvent>).actor;
    b.push(rel);
    const after = resourceRegistryOf(b.list);
    expect(after.byId.r0!.transfer).toBe('pending');
    expect(after.problems.join(' ')).toMatch(/no system or human actor/);
  });
});
