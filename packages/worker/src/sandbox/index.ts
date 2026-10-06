/**
 * @tecera/worker sandbox: the restricted child-process REPL, the verify runner, and the pieces they are
 * built from (profile, containment, frames, handles, killTree, env). Re-exported by the worker barrel.
 */
export { ChildProcessRepl, ReplTainted } from './host.js';
export type { ChildProcessReplOptions, SubInvokeRequest as ChildSubInvokeRequest, CheckpointRecord, SandboxEvidence, ExecTrace, CallTrace, ExecOutput, TaintReport, DisposeReport } from './host.js';
export { ProcessVerifyRunner, resolveVerifyPolicy, admitVerifyProfile, VERIFY_CONTROLS, VERIFY_TIMEOUT_EXIT, VERIFY_CANCEL_EXIT, VERIFY_SPAWN_EXIT, VERIFY_OUTPUT_CAP } from './verifyRunner.js';
export type { ProcessVerifyRunnerOptions, VerifyOutcomeExt, VerifyControl, VerifyIdentity, VerifyEvidence, VerifyProfile, VerifyHostEnv, VerifyAdmission, ResolvedVerifyPolicy } from './verifyRunner.js';
export { redactCapped, CappedStream, REDACT_LOOKAHEAD_CHARS, OUTPUT_WITHHELD, INTERRUPTED_MARKER, trailingTokenStart } from './capture.js';
export type { RedactCappedOptions } from './capture.js';
export { buildChildProfile, resolveIsolation, detectIsolation, nodeFlags, assertScratchDir, assertSandboxSettings, ISOLATION_CONTROLS } from './profile.js';
export type { SandboxSettings, IsolationProbe, ResolvedIsolation, ChildProfile, IsolationControl } from './profile.js';
export { detectContainment, Jail, sessionMembers, namespaceMembers, readProcStat, uidMembers, cgroupTreePids, cgroupPopulated, cgroupOwner, ContainmentStateError, probeCgroupMigration, procCgroup, VERIFY_CGROUP_PREFIX } from './contain.js';
export type { ContainmentProbe, ContainmentLayer, ReapResult, CgroupMigrationProbe, MigrationIdentity } from './contain.js';
export { CHILD_SOURCE, CHILD_LIMITS } from './child/entry.js';
export { killTree, groupAlive } from './killTree.js';
export { quarantineWorktree, worktreeQuarantine, releaseWorktreeQuarantine, listWorktreeQuarantines } from './quarantine.js';
export type { WorktreeQuarantine } from './quarantine.js';
export type { KillTreeResult } from './killTree.js';
export { HandleMint, ExecHandleTable, HandleLimitError, VIEW_METHODS, isHandleRef, promoteStrings } from './handles.js';
export type { HandleEntry } from './handles.js';
export { FrameReader, FrameError, decodeFrame, checkChildFrame, scanDepth } from './frames.js';
export { scrubEnv, isDeniedEnvName, assertEnvAllowlist, EnvRefused, SANDBOX_SAFE_ENV } from './env.js';
export type { ScrubbedEnv } from './env.js';
export { IsolationUnavailable, SuspendExec, sandboxError } from './errors.js';
export type { SandboxCode } from './errors.js';
