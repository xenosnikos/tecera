import { describe, expect, it } from 'vitest';
import { MANDATORY_HOOKS, ManifestError, REFLEX_OFF_REMOVED, findSecretLeaks, manifestHash, parseManifest, seatVendor, type ManifestInput } from './manifest.js';

export function baseManifest(): ManifestInput {
  return {
    schemaVersion: 1,
    id: 'bc_8f1e2a9c',
    name: 'sample',
    owner: 'owner@example.com',
    runtime: { tecera: '>=0.1.0 <0.2.0' },
    repo: { base: 'main', branchPrefix: 'tecera/', allowedChanges: ['src/**'] },
    providers: { anthropic: { auth: 'env:ANTHROPIC_API_KEY' }, openai: { auth: 'env:OPENAI_API_KEY' } },
    seats: {
      planner: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'high' },
      workers: [{ id: 'worker', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', effort: 'medium' }],
      reviewer: { provider: 'openai', model: 'gpt-5.6-terra', effort: 'high' },
      reflex: { provider: 'rules' },
    },
    budgets: { usd: 2, tokens: 200000, wallClockSec: 1200, maxDepth: 3, maxIterations: 20, maxAttempts: 2, maxChangedFiles: 5 },
    sandbox: { profile: 'process', isolation: 'node', network: false, memoryMb: 256, execTimeoutSec: 60 },
    policy: {
      protectedPaths: ['tecera.json', '.tecera/**', '**/*.test.*'],
      approvals: { required: ['open_pr'], ttlSec: 900, quorum: 1, separationOfDuty: true },
      failure: { onVerifyFail: 'retry-once', onReviewFail: 'retry-once', onLedgerError: 'stop' },
    },
    verify: { command: 'npm test', timeoutSec: 300 },
    review: { foreign: true, maxAttempts: 1 },
    hooks: { mandatory: [...MANDATORY_HOOKS] },
  };
}

describe('parseManifest', () => {
  it('accepts a valid manifest and applies defaults', () => {
    const m = parseManifest(baseManifest());
    expect(m.reflexes.threshold).toBe(0.6);
    expect(m.commitment).toBe('single-minded');
    expect(m.board.driver).toBe('ledger');
    expect(m.sandbox.envAllowlist).toEqual(['PATH', 'HOME', 'CI']);
  });

  it('rejects unknown fields at every level', () => {
    const doc = { ...baseManifest(), surprise: true } as Record<string, unknown>;
    expect(() => parseManifest(doc)).toThrow(ManifestError);
    const nested = baseManifest();
    (nested.budgets as Record<string, unknown>).extra = 1;
    expect(() => parseManifest(nested)).toThrow(ManifestError);
  });

  it('rejects inline credentials anywhere in the document', () => {
    const doc = baseManifest();
    doc.providers = { anthropic: { auth: 'env:A' }, openai: { auth: 'sk-ant-api03-abcdefghijklmnop' } };
    expect(() => parseManifest(doc)).toThrow(/credential-looking/);
    const leak = baseManifest();
    leak.name = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
    expect(findSecretLeaks(leak as never)).toEqual([{ path: 'name', kind: 'github' }]);
  });

  it('rejects secret references that are not env:/file:/keychain:', () => {
    const doc = baseManifest();
    doc.providers = { anthropic: { auth: 'plain-text-value' }, openai: { auth: 'env:OPENAI_API_KEY' } };
    expect(() => parseManifest(doc)).toThrow(ManifestError);
  });

  it('rejects blanket allowedChanges globs', () => {
    const doc = baseManifest();
    doc.repo.allowedChanges = ['**'];
    expect(() => parseManifest(doc)).toThrow(/blanket glob/);
  });

  it('requires hooks.mandatory to equal MANDATORY_HOOKS exactly', () => {
    const missing = baseManifest();
    missing.hooks.mandatory = missing.hooks.mandatory.filter((h) => h !== 'verifyGate');
    expect(() => parseManifest(missing)).toThrow(/missing: verifyGate/);
    const extra = baseManifest();
    extra.hooks.mandatory = [...extra.hooks.mandatory, 'autoApprove'];
    expect(() => parseManifest(extra)).toThrow(/extra: autoApprove/);
  });

  it('D5: review.foreign must be true; the reviewer must differ from every worker in provider, credential and vendor', () => {
    const doc = baseManifest();
    doc.seats.reviewer = { provider: 'anthropic', model: 'claude-opus-5', effort: 'high' };
    expect(() => parseManifest(doc)).toThrow(/differ from every worker/);
    // turning foreign review off is no longer an escape hatch
    const off = baseManifest();
    (off.review as Record<string, unknown>).foreign = false;
    expect(() => parseManifest(off)).toThrow(/review.foreign must be true/);
    // same credential under two provider names is not foreign
    const sameKey = baseManifest();
    sameKey.providers = { anthropic: { auth: 'env:ONE_KEY' }, openai: { auth: 'env:ONE_KEY' } };
    expect(() => parseManifest(sameKey)).toThrow(/another credential/);
    // an OpenRouter reviewer serving the workers' vendor is not foreign
    const sameVendor = baseManifest();
    sameVendor.providers = { ...sameVendor.providers, openrouter: { auth: 'env:OPENROUTER_API_KEY' } };
    sameVendor.seats.reviewer = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5', effort: 'high' };
    expect(() => parseManifest(sameVendor)).toThrow(/vendor \(anthropic\)/);
    sameVendor.seats.reviewer = { provider: 'openrouter', model: 'openai/gpt-5.6-terra', effort: 'high' };
    expect(() => parseManifest(sameVendor)).not.toThrow();
    expect(seatVendor({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' })).toBe('anthropic');
    expect(seatVendor({ provider: 'openai', model: 'gpt-5.6-terra' })).toBe('openai');
  });

  it("D2: reflexes are always on: 'off' is rejected with a readable issue; unset seams default to rule, or model with a decision-model provider", () => {
    for (const seam of ['triage', 'choosePlan', 'route', 'gate', 'reconsider', 'closeOut'] as const) {
      const doc = baseManifest();
      doc.reflexes = { [seam]: 'off' } as never;
      try {
        parseManifest(doc);
        throw new Error('unreachable');
      } catch (e) {
        expect(e).toBeInstanceOf(ManifestError);
        expect((e as ManifestError).issues).toContainEqual({ path: `reflexes.${seam}`, message: REFLEX_OFF_REMOVED });
      }
    }
    const m = parseManifest(baseManifest());
    expect(m.reflexes).toEqual({ triage: 'rule', choosePlan: 'rule', route: 'rule', gate: 'rule', reconsider: 'rule', closeOut: 'rule', threshold: 0.6 });
    const model = baseManifest();
    model.seats.reflex = { provider: 'jev', model: 'jev-1' };
    model.reflexes = { route: 'rule' };
    const mm = parseManifest(model);
    expect(mm.reflexes).toMatchObject({ triage: 'model', choosePlan: 'model', route: 'rule', gate: 'model', reconsider: 'model', closeOut: 'model' });
  });

  it('D3: budgets.enforce defaults to false; true is accepted', () => {
    expect(parseManifest(baseManifest()).budgets.enforce).toBe(false);
    const doc = baseManifest();
    (doc.budgets as Record<string, unknown>).enforce = true;
    expect(parseManifest(doc).budgets.enforce).toBe(true);
  });

  it("D6: approvals.required defaults to ['open_pr'], always contains it, and refuses 'commit'", () => {
    const doc = baseManifest();
    delete (doc.policy.approvals as Record<string, unknown>).required;
    expect(parseManifest(doc).policy.approvals.required).toEqual(['open_pr']);
    const other = baseManifest();
    other.policy.approvals.required = ['externalWrite'];
    expect(parseManifest(other).policy.approvals.required).toEqual(['externalWrite', 'open_pr']);
    const commit = baseManifest();
    commit.policy.approvals.required = ['commit', 'open_pr'];
    expect(() => parseManifest(commit)).toThrow(/'commit' no longer requires approval/);
  });

  it('requires seat providers to be declared', () => {
    const doc = baseManifest();
    doc.seats.planner = { provider: 'google', model: 'x', effort: 'high' };
    expect(() => parseManifest(doc)).toThrow(/not declared in providers/);
  });

  it('refuses separationOfDuty=false and quorum != 1', () => {
    const doc = baseManifest();
    (doc.policy.approvals as Record<string, unknown>).separationOfDuty = false;
    expect(() => parseManifest(doc)).toThrow(ManifestError);
  });

  it('collects every issue in the error', () => {
    const doc = baseManifest();
    doc.repo.allowedChanges = ['**'];
    doc.hooks.mandatory = [];
    try {
      parseManifest(doc);
      throw new Error('unreachable');
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError);
      expect((e as ManifestError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('manifestHash', () => {
  it('is stable across key order and whitespace', () => {
    const reverseKeys = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(reverseKeys);
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v).reverse()) out[k] = reverseKeys((v as Record<string, unknown>)[k]);
        return out;
      }
      return v;
    };
    const a = parseManifest(baseManifest());
    const b = parseManifest(reverseKeys(baseManifest()));
    expect(manifestHash(a)).toBe(manifestHash(b));
    expect(manifestHash(a)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when any field changes', () => {
    const a = parseManifest(baseManifest());
    const doc = baseManifest();
    doc.budgets.usd = 3;
    const b = parseManifest(doc);
    expect(manifestHash(a)).not.toBe(manifestHash(b));
  });
});
