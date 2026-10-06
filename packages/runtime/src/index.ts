/**
 * @tecera/runtime: the composition root and the `tecera` CLI. `main(argv)` is the CLI; `createRuntime`
 * loads a business case for embedding; `wireRunPorts` is the single seam wave 2 fills with providers,
 * planner, gates and the worker sandbox.
 */
export { main, COMMANDS, helpText } from './cli/main.js';
export type { MainOptions } from './cli/main.js';
export { parseArgs, UsageError } from './cli/args.js';
export type { ParsedArgs } from './cli/args.js';
export { EXIT, NotWired, CliError, RUNTIME_VERSION } from './errors.js';
export type { ExitCode } from './errors.js';
export { Runtime, createRuntime, stripUndefined } from './runtime.js';
export type { RuntimeOptions } from './runtime.js';
export {
  locateManifest,
  readManifestDoc,
  loadManifest,
  loadPermissions,
  computeLock,
  computeLockFrom,
  readLock,
  writeLock,
  lockDrift,
  ManifestLoadError,
  MANIFEST_FILE,
  PERMISSIONS_PATH,
  LOCK_PATH,
} from './manifest/load.js';
export type { LoadedManifest, LockFile } from './manifest/load.js';
export { validateBusinessCase, scanSecrets } from './manifest/validate.js';
export type { Issue, ValidationReport } from './manifest/validate.js';
export { loadGoal, resolveGoal, parseGoalFile, effectiveBudget, listGoalIds, GoalError } from './goals.js';
export type { GoalSpec } from './goals.js';
export { PlanRegistry, PlanDecisionError } from './plans.js';
export type { RegisteredPlan, PlanDecision, PlanVerdict } from './plans.js';
export { wireRunPorts, defaultProbe, createProbe, createWiring, verifyIdentity, MeteredPlanner, SEAT_RESERVATION, VERIFY_UID_ENV, VERIFY_GID_ENV, VERIFY_ALLOW_ROOT_ENV, WiringError, exhaustionRecorder, ledgerCostSink, ghEnvOf, GH_ENV_KEYS } from './wiring.js';
export type { WiringContext, WiredPorts, WireFn, WiringOptions, SeatProbe, SeatRef, ProbeResult, BaselineResult } from './wiring.js';
export { leaseWorktree, LeaseLost, worktreesRoot, WORKTREES_ENV, snapshotTree, restoreTree } from './worktree.js';
export type { LeasedWorktree, LeaseOptions } from './worktree.js';
export { fencedTool, fencedVerifyRunner, leaseGuard, leasedGateContext, mutationCheck } from './fencing.js';
export type { LiveLease } from './fencing.js';
export { SeatMeter, meteredLLM, cancellableLLM, isBudgetRefusal, isAccountingBroken } from './metering.js';
export { reapPriorProcesses, OwnershipRecorder, ownerFilePath, readRecords } from './ownership.js';
export type { ProcRecord, ReapResult } from './ownership.js';
export type { SeatReservation } from './metering.js';
export { ModelFrontier } from './frontier.js';
export type { ModelFrontierOptions } from './frontier.js';
export { replayRun } from './replay.js';
export type { ReplayReport, ReplayedGoal, ReplayOptions } from './replay.js';
export { deferStaging, stageAchievedPlans, STAGED_AFTER } from './staging.js';
export { assertLedgerPath } from './runtime.js';
export {
  executeRun,
  resumeRun,
  exitCodeForRun,
  ledgerDecisionSink,
  policyValidator,
  effectiveManifest,
  cancellableGates,
  cancellableWorker,
  policyFingerprint,
  runCost,
  DEFAULT_TOOL_CATALOG,
} from './commands/run.js';
export type { RunOutcome, RunResult } from './commands/run.js';
export { toolingProblem } from './verify.js';
export { admitVerify, ContainedVerifyRunner, VerifyContainmentError } from './containment.js';
export type { AdmittedVerify, VerifyIdentity } from './containment.js';
export { SAFE_ENV, buildVerifyEnv, reviewAllowlist, unsafeEnvName, UnsafeEnvError } from './env.js';
export type { VerifyEnv, AllowlistReview } from './env.js';
export { RuntimeSecrets, envSecretInputs, envRedactor, CREDENTIAL_NAME } from './secrets.js';
export type { SecretStatus } from './secrets.js';
export { RedactingLedger } from './redactingLedger.js';
export { executionReadiness } from './readiness.js';
export type { ReadinessProblem } from './readiness.js';
export { localPrincipal, identityJson, PrincipalError } from './principal.js';
export { costRecordingLLM, costReport, costLine, costMarkdown, costCalls, COST_KIND } from './cost.js';
export type { CostCall, CostReport, CostRow, CostSink } from './cost.js';
export { activeRunForStop, evaluateStop, proofEvidenceProblem, RESUMABLE_EXITS } from './stopHook.js';
export type { ActiveRun, StopEvaluation } from './stopHook.js';
export { providerSetup, providerOptions, withIdentity, nativeOpenRouter, isOpenRouter, OPENROUTER_API, OPENROUTER_PROVIDER, PROVIDER_KEY_ENV } from './providerSetup.js';
export type { ProviderSetup } from './providerSetup.js';
export type { HumanIdentity } from './principal.js';
export { decidePreTool, decideBash, parseHookInput, stopReminder, shellWords, HOST_PROTECTED, READ_ONLY_TOOLS } from './hook.js';
export type { HookInput, HookDecision, HookContext } from './hook.js';
export { inspectPath, safeReadFile, safeWriteFile, safeMkdirp, walkTree, UnsafePathError } from './util/safefs.js';
export { installAdapter, checkAdapter, readAdapter, AdapterError } from './adapters/install.js';
export { renderBrainSummary, renderPermissionsSettings } from './adapters/render.js';
export { applyManagedBlock, jsonMerge, BLOCK_START, BLOCK_END } from './adapters/merge.js';
export { PlannedFs } from './vfs.js';
export type { Env } from './util/proc.js';
