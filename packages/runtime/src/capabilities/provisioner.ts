import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chownSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resourceProblem, type ProvisionedResource, type ProvisioningAllowance, type Provisioner } from '@tecera/contracts';
import { GIT_ENV, GIT_SAFE_ARGS } from '@tecera/policy';
import { defaultIds, type IdGen } from '../util/ids.js';
import type { Env } from '../util/proc.js';
import { STUB_CONFIG, STUB_PID, STUB_PORT, STUB_REQUESTS, STUB_SCRIPT, STUB_SOURCE, type HttpStubConfig, type StubRequest } from './httpStub.js';

/**
 * The local provisioner (D10, D12): what Tecera may create in its own space when a capability is missing.
 * Four kinds, all on this machine, none costing money:
 *
 * - `tmpdir`: an empty directory (locator: its path);
 * - `git-remote`: a bare repository that can receive the work-branch push (locator: its path);
 * - `sqlite`: a database file (locator: its path);
 * - `http-stub`: a loopback HTTP server that records requests and returns configured responses
 *   (locator: `http://127.0.0.1:<port>`).
 *
 * Every resource lives under a Tecera-owned root (`$TECERA_RESOURCES`, default `~/.tecera/resources`) that is
 * never inside the repository working tree: `<root>/<id>/` holds the resource, `<root>/.records/<id>.json`
 * the record (mode 0700, out of the verify identity's reach). The allowance is enforced before anything is
 * created (scope local, kind allowed and supported, at most maxResources in the run, a lifetime no longer
 * than ttlSec), and the finished record must pass contracts' resourceProblem or it is torn down and refused.
 *
 * The teardown is a readable shell line, but release never hands it to a shell: it recomputes the teardown
 * this provisioner writes for the resource's kind and id and runs that only when the recorded one is
 * identical (a teardown edited in the ledger is refused with exit 126). Release is idempotent: a resource
 * already gone releases with exit 0. An http-stub's teardown succeeds only when no process of that stub is
 * left (found through /proc by its command line, not only through its pid file).
 *
 * Release and transfer of one resource are serialised by a lock file in the records directory
 * (`exclusive`), so a release that read a pending row cannot tear down what a transfer has just recorded.
 */

export const RESOURCES_ENV = 'TECERA_RESOURCES';
export const LOCAL_KINDS = ['tmpdir', 'git-remote', 'sqlite', 'http-stub'] as const;
export type LocalKind = (typeof LOCAL_KINDS)[number];

/** Teardown exit when the recorded teardown is not one this provisioner wrote for the resource. */
export const TEARDOWN_REFUSED = 126;

const RECORDS = '.records';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STUB_START_MS = 10_000;

export class ProvisioningRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningRefused';
  }
}

export function resourcesRoot(env: Env): string {
  const v = env[RESOURCES_ENV];
  if (v !== undefined && v !== '') {
    if (!isAbsolute(v)) throw new ProvisioningRefused(`${RESOURCES_ENV} must be an absolute path`);
    return resolve(v);
  }
  return join(homedir(), '.tecera', 'resources');
}

/** The path as the filesystem resolves it (its deepest existing ancestor through realpath). */
function realish(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cur = parent;
    }
  }
}

function inside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/**
 * Whether a resource path lies where this provisioner makes resources: strictly under `root` and outside
 * `repoRoot`, both as the filesystem resolves them. A recorded locator anywhere else (the business repository,
 * another user's directory) is not Tecera's own space, whatever the event says.
 */
export function locatorWithin(locator: string, root: string, repoRoot: string): boolean {
  if (!isAbsolute(locator)) return false;
  const loc = realish(locator);
  const base = realish(root);
  return loc !== base && inside(loc, base) && !inside(loc, realish(repoRoot));
}

const quote = (p: string): string => `'${p}'`;

/** The teardown line this provisioner records for a resource of `kind` living in `dir`. */
export function teardownFor(kind: string, dir: string): string {
  if (kind === 'http-stub') return `kill -TERM "$(cat ${quote(join(dir, STUB_PID))})"; rm -rf -- ${quote(dir)}`;
  return `rm -rf -- ${quote(dir)}`;
}

export interface ReleaseResult {
  resourceId: string;
  /** 0 when the resource is gone (released now or already); non-zero when it may still exist. */
  teardownExit: number;
  /** It was already gone before this release. */
  already: boolean;
  reason?: string;
}

export interface LocalProvisionerOptions {
  /** The Tecera-owned root (resourcesRoot(env)). Never inside `repoRoot`. */
  root: string;
  /** The repository working tree the resources must stay out of. */
  repoRoot: string;
  /** The manifest's `provisioning` block. */
  allowance: ProvisioningAllowance;
  /** The run the resources are provisioned for. */
  runId: string;
  /** Resources already provisioned in this run (from the ledger registry): they count toward maxResources. */
  provisionedSoFar?: number;
  /** The verify identity: tmpdir and sqlite payloads are handed to it so a contained check can use them. */
  share?: { uid: number; gid: number };
  /** Values that must never appear in a locator (the runtime redactor's containsSecret). */
  secrets?: (value: string) => boolean;
  now?: () => number;
  ids?: IdGen;
  /** PATH for git and the stub's node (default: the parent's). */
  path?: string;
  /** How a stub process is signalled (default process.kill; tests). */
  kill?: StubKill;
}

/** What a guard run under the resource lock decides before a teardown: go on, already released, or refuse. */
export type ReleaseGuard = () => Promise<null | { already: true } | { refuse: string }>;

export type StubKill = (pid: number, signal: NodeJS.Signals) => void;

/** Why an allowance cannot be enforced as given (null when it can). */
export function allowanceProblem(a: ProvisioningAllowance): string | null {
  if (a.scope !== 'local' && a.scope !== 'none') return `provisioning scope ${String(a.scope)} is not local or none`;
  if (!Array.isArray(a.kinds) || a.kinds.some((k) => typeof k !== 'string')) return 'provisioning kinds must be a list of names';
  if (!Number.isInteger(a.maxResources) || a.maxResources < 0) return 'provisioning maxResources must be a whole number, 0 or more';
  if (!Number.isInteger(a.ttlSec) || a.ttlSec <= 0) return 'provisioning ttlSec must be a positive whole number of seconds';
  return null;
}

export interface ProvisionNeed {
  capability: string;
  kind: string;
  goalId: string;
  /** A shorter lifetime than the allowance's ttlSec. */
  ttlSec?: number;
  /** http-stub: the initial responses. */
  stub?: HttpStubConfig;
}

export class LocalProvisioner implements Provisioner {
  readonly root: string;
  private count: number;

  constructor(private readonly o: LocalProvisionerOptions) {
    if (!isAbsolute(o.root)) throw new ProvisioningRefused('the resources root must be an absolute path');
    if (/['"$`\\\s]/.test(o.root)) throw new ProvisioningRefused('the resources root may not contain quotes, $, backquotes, backslashes or whitespace');
    this.root = resolve(o.root);
    const r = realish(this.root);
    const repo = realish(o.repoRoot);
    if (inside(r, repo) || inside(repo, r)) throw new ProvisioningRefused('the resources root must lie outside the repository working tree');
    const bad = allowanceProblem(o.allowance);
    if (bad) throw new ProvisioningRefused(bad);
    const so = o.provisionedSoFar ?? 0;
    if (!Number.isInteger(so) || so < 0) throw new ProvisioningRefused('provisionedSoFar must be a whole number, 0 or more');
    this.count = so;
  }

  kinds(): readonly string[] {
    return LOCAL_KINDS;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private dirOf(id: string): string {
    return join(this.root, id);
  }

  private recordPath(id: string): string {
    return join(this.root, RECORDS, `${id}.json`);
  }

  private ensureRoot(): void {
    const own = (d: string): void => {
      const st = lstatSync(d);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new ProvisioningRefused(`${d} is not a directory Tecera owns`);
      const uid = typeof process.geteuid === 'function' ? process.geteuid() : null;
      if (uid !== null && st.uid !== uid) throw new ProvisioningRefused(`${d} is owned by uid ${st.uid}, not by this process (uid ${uid})`);
      if (st.mode & 0o022) throw new ProvisioningRefused(`${d} is writable by group or others`);
    };
    for (const d of [this.root, join(this.root, RECORDS)]) if (existsSync(d)) own(d);
    // 0711: the verify identity may reach the resources it was handed, not list them; records stay private.
    mkdirSync(this.root, { recursive: true, mode: 0o711 });
    mkdirSync(join(this.root, RECORDS), { recursive: true, mode: 0o700 });
    for (const d of [this.root, join(this.root, RECORDS)]) own(d);
    // Checked again on the created path: an ancestor swapped for a link into the repository is caught here.
    if (inside(realpathSync(this.root), realish(this.o.repoRoot))) throw new ProvisioningRefused('the resources root must lie outside the repository working tree');
  }

  /** Resources of this run recorded under this root (another provisioner of the run counts too). */
  private recordedForRun(): number {
    const dir = join(this.root, RECORDS);
    if (!existsSync(dir)) return 0;
    let n = 0;
    for (const f of readdirSync(dir)) if (f.endsWith('.json') && this.record(f.slice(0, -5))?.runId === this.o.runId) n++;
    return n;
  }

  /** Why `need` may not be provisioned now (null when it may). */
  refusal(need: Pick<ProvisionNeed, 'kind' | 'ttlSec'>): string | null {
    const a = this.o.allowance;
    if (a.scope !== 'local') return `provisioning scope is ${a.scope}: nothing may be provisioned`;
    if (!a.kinds.includes(need.kind)) return `kind ${need.kind} is outside the allowance (${a.kinds.join(', ') || 'none'})`;
    if (!(LOCAL_KINDS as readonly string[]).includes(need.kind)) return `kind ${need.kind} cannot be provisioned locally`;
    // The ledger count (provisionedSoFar) is the authority; live local records of the run are a floor under it.
    const used = Math.max(this.count, this.recordedForRun());
    if (used >= a.maxResources) return `run ${this.o.runId} already provisioned ${used} of ${a.maxResources} resources`;
    if (need.ttlSec !== undefined && (!Number.isInteger(need.ttlSec) || need.ttlSec <= 0)) return 'a requested lifetime must be a positive number of seconds';
    return null;
  }

  async provision(need: ProvisionNeed): Promise<ProvisionedResource> {
    const why = this.refusal(need);
    if (why) throw new ProvisioningRefused(why);
    if (!need.capability || !need.goalId) throw new ProvisioningRefused('a resource needs a capability and a goal');
    this.ensureRoot();
    const id = (this.o.ids ?? defaultIds)('res');
    if (!ID.test(id)) throw new ProvisioningRefused(`resource id ${JSON.stringify(id)} is not a plain id`);
    const dir = this.dirOf(id);
    if (existsSync(dir)) throw new ProvisioningRefused(`resource ${id} already exists`);
    // Counted before anything exists: a failed attempt still used a slot of the run.
    this.count++;
    const createdAt = this.now();
    const ttlSec = Math.min(need.ttlSec ?? this.o.allowance.ttlSec, this.o.allowance.ttlSec);
    const expiresAt = createdAt + ttlSec * 1000;
    mkdirSync(dir, { mode: 0o711 });
    let locator: string;
    try {
      locator = await this.create(need.kind as LocalKind, dir, expiresAt, need.stub);
    } catch (e) {
      await this.teardown(need.kind, dir);
      throw new ProvisioningRefused(`could not provision ${need.kind}: ${(e as Error).message}`);
    }
    const r: ProvisionedResource = {
      id,
      capability: need.capability,
      kind: need.kind,
      provider: 'local',
      locator,
      teardown: teardownFor(need.kind, dir),
      createdAt,
      expiresAt,
      transfer: 'pending',
      goalId: need.goalId,
      runId: this.o.runId,
    };
    const bad = resourceProblem(r, this.o.allowance, this.o.secrets);
    if (bad) {
      await this.teardown(need.kind, dir);
      throw new ProvisioningRefused(bad);
    }
    try {
      this.writeRecord(r);
    } catch (e) {
      // Without its record nothing would ever find the resource again (list and the sweep read records).
      await this.teardown(need.kind, dir);
      throw new ProvisioningRefused(`could not record ${need.kind} ${id}: ${(e as Error).message}`);
    }
    return r;
  }

  private gitEnv(): NodeJS.ProcessEnv {
    return { ...GIT_ENV, PATH: this.o.path ?? GIT_ENV.PATH ?? '' };
  }

  private hand(p: string): void {
    if (this.o.share) chownSync(p, this.o.share.uid, this.o.share.gid);
  }

  private async create(kind: LocalKind, dir: string, expiresAt: number, stub?: HttpStubConfig): Promise<string> {
    switch (kind) {
      case 'tmpdir': {
        const p = join(dir, 'work');
        mkdirSync(p, { mode: 0o700 });
        this.hand(p);
        return p;
      }
      case 'git-remote': {
        const p = join(dir, 'remote.git');
        const r = spawnSync('git', [...GIT_SAFE_ARGS, 'init', '-q', '--bare', p], { env: this.gitEnv(), encoding: 'utf8', timeout: 15_000 });
        if (r.error || r.status !== 0) throw new Error(`git init --bare failed: ${(r.error?.message ?? r.stderr ?? '').trim()}`);
        return p;
      }
      case 'sqlite': {
        const data = join(dir, 'data');
        mkdirSync(data, { mode: 0o700 });
        const p = join(data, 'db.sqlite');
        // A child keeps node:sqlite's experimental warning out of the CLI's output.
        const script = "const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(process.argv[1]); d.exec('PRAGMA user_version = 1'); d.close();";
        const r = spawnSync(process.execPath, ['--no-warnings', '-e', script, p], { env: { PATH: this.o.path ?? process.env.PATH ?? '' }, encoding: 'utf8', timeout: 15_000 });
        if (r.error || r.status !== 0 || !existsSync(p)) throw new Error(`creating the database failed: ${(r.error?.message ?? r.stderr ?? '').trim()}`);
        this.hand(data);
        this.hand(p);
        return p;
      }
      case 'http-stub':
        return this.startStub(dir, expiresAt, stub ?? { routes: [] });
    }
  }

  private async startStub(dir: string, expiresAt: number, cfg: HttpStubConfig): Promise<string> {
    writeFileSync(join(dir, STUB_SCRIPT), STUB_SOURCE, { mode: 0o600 });
    writeFileSync(join(dir, STUB_CONFIG), JSON.stringify(cfg), { mode: 0o600 });
    const child = spawn(process.execPath, ['--no-warnings', join(dir, STUB_SCRIPT), dir, String(expiresAt)], { cwd: dir, detached: true, stdio: 'ignore', env: { PATH: this.o.path ?? process.env.PATH ?? '' } });
    if (!child.pid) throw new Error('the stub did not start');
    writeFileSync(join(dir, STUB_PID), String(child.pid), { mode: 0o600 });
    child.unref();
    const portFile = join(dir, STUB_PORT);
    const deadline = Date.now() + STUB_START_MS;
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        const port = Number(readFileSync(portFile, 'utf8').trim());
        if (Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`;
      }
      if (child.exitCode !== null) throw new Error(`the stub exited (${child.exitCode})`);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the stub did not listen in time');
  }

  /** Replace an http-stub's responses (re-read by the stub on every request). */
  configureStub(resourceId: string, cfg: HttpStubConfig): void {
    const r = this.record(resourceId);
    if (!r || r.kind !== 'http-stub' || r.transfer !== 'pending') throw new ProvisioningRefused(`no pending http-stub ${resourceId}`);
    const p = join(this.dirOf(resourceId), STUB_CONFIG);
    const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(cfg), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, p);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** The requests an http-stub recorded, oldest first. */
  stubRequests(resourceId: string): StubRequest[] {
    if (!ID.test(resourceId)) return [];
    const p = join(this.dirOf(resourceId), STUB_REQUESTS);
    if (!existsSync(p)) return [];
    const out: StubRequest[] = [];
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as StubRequest);
      } catch {
        /* a torn last line */
      }
    }
    return out;
  }

  private writeRecord(r: ProvisionedResource): void {
    const p = this.recordPath(r.id);
    // A fresh temp name created exclusively: nothing planted under a fixed name is written through.
    const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(r), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, p);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  /**
   * Run `fn` holding the lock of `resourceId` (an exclusive file in the records directory naming the holder's
   * pid). A lock whose holder is gone is taken over; one held by a live process refuses (ProvisioningRefused).
   */
  async exclusive<T>(resourceId: string, fn: () => Promise<T>): Promise<T> {
    if (!ID.test(resourceId)) throw new ProvisioningRefused(`resource id ${JSON.stringify(resourceId)} is not a plain id`);
    this.ensureRoot();
    const p = join(this.root, RECORDS, `${resourceId}.lock`);
    const take = (): number | null => {
      try {
        return openSync(p, 'wx', 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null;
        throw e;
      }
    };
    let fd = take();
    if (fd === null) {
      let holder = 0;
      try {
        holder = Number(readFileSync(p, 'utf8').trim());
      } catch {
        /* released meanwhile */
      }
      // An empty lock is being written by its holder: busy, not stale.
      if (Number.isInteger(holder) && holder > 0 && !alive(holder)) {
        rmSync(p, { force: true });
        fd = take();
      }
    }
    if (fd === null) throw new ProvisioningRefused(`resource ${resourceId} is being released or transferred by another process`);
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    try {
      return await fn();
    } finally {
      rmSync(p, { force: true });
    }
  }

  /** The local record of a resource this root holds (null when none). */
  record(resourceId: string): ProvisionedResource | null {
    if (!ID.test(resourceId)) return null;
    try {
      const r = JSON.parse(readFileSync(this.recordPath(resourceId), 'utf8')) as ProvisionedResource;
      return r && r.id === resourceId ? r : null;
    } catch {
      return null;
    }
  }

  /** Every resource recorded under this root (pending and transferred; released ones are gone). */
  async list(): Promise<ProvisionedResource[]> {
    const dir = join(this.root, RECORDS);
    if (!existsSync(dir)) return [];
    const out: ProvisionedResource[] = [];
    for (const n of readdirSync(dir).sort()) {
      if (!n.endsWith('.json')) continue;
      const r = this.record(n.slice(0, -5));
      if (r) out.push(r);
    }
    return out;
  }

  /** Mark a resource as taken over by a human: release and the expiry sweep leave it alone from now on. */
  markTransferred(resourceId: string): void {
    const r = this.record(resourceId);
    if (r) this.writeRecord({ ...r, transfer: 'transferred' });
  }

  async release(resourceId: string): Promise<void> {
    const r = this.record(resourceId);
    if (!r) {
      if (ID.test(resourceId) && existsSync(this.dirOf(resourceId))) throw new ProvisioningRefused(`resource ${resourceId} has no record here; release it through the ledger record`);
      return;
    }
    const res = await this.releaseResource(r);
    if (res.teardownExit !== 0) throw new ProvisioningRefused(`resource ${resourceId}: teardown exited ${res.teardownExit}${res.reason ? ` (${res.reason})` : ''}`);
  }

  /**
   * Run the recorded teardown of `r` (a ledger or local record). Refused (TEARDOWN_REFUSED) unless the
   * teardown is exactly the one this provisioner writes for r's kind and id under this root; refused (1)
   * when the local record says a human took it over. Idempotent. Runs under the resource lock; `guard`
   * (the ledger's current word, from releaseRecorded) is asked under that lock before anything is removed.
   */
  async releaseResource(r: Pick<ProvisionedResource, 'id' | 'kind' | 'teardown'>, o: { guard?: ReleaseGuard } = {}): Promise<ReleaseResult> {
    if (!ID.test(r.id)) return { resourceId: String(r.id), teardownExit: TEARDOWN_REFUSED, already: false, reason: 'not a resource id' };
    const dir = this.dirOf(r.id);
    if (r.teardown !== teardownFor(r.kind, dir)) return { resourceId: r.id, teardownExit: TEARDOWN_REFUSED, already: false, reason: 'the recorded teardown is not one this provisioner wrote for it' };
    try {
      return await this.exclusive(r.id, async (): Promise<ReleaseResult> => {
        if (this.record(r.id)?.transfer === 'transferred') return { resourceId: r.id, teardownExit: 1, already: false, reason: 'a human took it over; Tecera no longer tears it down' };
        const g = o.guard ? await o.guard() : null;
        if (g && 'refuse' in g) return { resourceId: r.id, teardownExit: 1, already: false, reason: g.refuse };
        if (g && 'already' in g) return { resourceId: r.id, teardownExit: 0, already: true };
        let present = false;
        try {
          lstatSync(dir);
          present = true;
        } catch {
          present = false;
        }
        const exit = present ? await this.teardown(r.kind, dir) : 0;
        if (exit === 0) rmSync(this.recordPath(r.id), { force: true });
        return { resourceId: r.id, teardownExit: exit, already: !present, ...(exit ? { reason: r.kind === 'http-stub' ? 'the stub could not be proven stopped, or its directory removed' : 'the resource could not be removed' } : {}) };
      });
    } catch (e) {
      if (!(e instanceof ProvisioningRefused)) throw e;
      return { resourceId: r.id, teardownExit: 1, already: false, reason: e.message };
    }
  }

  /** The teardown itself: stop a stub that is really ours, then remove the directory. 0 when gone. */
  private async teardown(kind: string, dir: string): Promise<number> {
    // A stub that may still be running is no release: the directory (and its pid file) stay for a retry.
    if (kind === 'http-stub' && !(await stopStub(dir, this.o.kill ? { kill: this.o.kill } : {}))) return 1;
    try {
      const st = lstatSync(dir);
      // A symlink planted in place of the directory: remove the link, never what it points at.
      rmSync(dir, { recursive: !st.isSymbolicLink(), force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return 1;
    }
    return existsSync(dir) ? 1 : 0;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when `pid` is the stub started from `dir` (its command line names the script in that directory). */
function isOurStub(pid: number, dir: string): boolean {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return argv.includes(join(dir, STUB_SCRIPT)) && argv.includes(dir);
  } catch {
    return false;
  }
}

/** True when `pid`, once the stub of `dir`, has ended: no such pid, a zombie, or a pid now reused by another program. */
function ended(pid: number, dir: string): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return true;
  }
  const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
  if (state === 'Z' || state === 'X' || state === 'x') return true;
  let cmd = '';
  try {
    cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return true;
  }
  return cmd !== '' && !isOurStub(pid, dir);
}

/**
 * Every live process that is the stub of `dir`, found by command line in /proc (the pid file may be missing,
 * stale or edited). null when /proc cannot be read: nothing can then be proven.
 */
function stubProcesses(dir: string): number[] | null {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return null;
  }
  const out: number[] = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    // A zombie has an empty command line: it is not counted, it no longer serves.
    if (pid > 1 && pid !== process.pid && isOurStub(pid, dir)) out.push(pid);
  }
  return out;
}

/**
 * Stop the stub of `dir`: SIGTERM, SIGKILL after 2 s, then wait up to 1 s more. Only processes whose command
 * line names this directory's stub script are signalled, each re-checked just before its signal. True only
 * when no such process is left; false when one survived or /proc could not be read.
 */
export async function stopStub(dir: string, o: { kill?: StubKill } = {}): Promise<boolean> {
  const kill = o.kill ?? ((pid: number, sig: NodeJS.Signals) => void process.kill(pid, sig));
  const signal = (pids: number[], sig: NodeJS.Signals): void => {
    for (const pid of pids) {
      if (!isOurStub(pid, dir)) continue;
      try {
        kill(pid, sig);
      } catch {
        /* gone, or not ours to signal: the next look decides */
      }
    }
  };
  // A stub seen once stays tracked until its pid is gone or a zombie: an exiting process has an empty command
  // line before it has closed its socket, so the command line alone would call it gone too early.
  const tracked = new Set<number>();
  const look = (): number[] | null => {
    const now = stubProcesses(dir);
    if (now === null) return null;
    for (const pid of now) tracked.add(pid);
    for (const pid of [...tracked]) if (ended(pid, dir)) tracked.delete(pid);
    return [...tracked];
  };
  const wait = async (rounds: number): Promise<number[] | null> => {
    let left = look();
    for (let i = 0; i < rounds && left !== null && left.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      left = look();
    }
    return left;
  };
  let left = look();
  if (left === null) return false;
  if (!left.length) return true;
  signal(left, 'SIGTERM');
  left = await wait(40);
  if (left === null) return false;
  if (!left.length) return true;
  signal(left, 'SIGKILL');
  left = await wait(20);
  return left !== null && left.length === 0;
}
