/** Public surface of the invoke lane: loop, broker, protocol, tools, and test doubles. */
export { invoke, resume, loadInvokeCheckpoint, nextPendingRequest, sanitizeOutcome, InvokeError, isTainted } from './invoke.js';
export type { InvokeOptions, ResumeDeps, InvokeCheckpoint, TaintedOutcome } from './invoke.js';
export { StepWorker } from './stepWorker.js';
export type { StepWorkerOptions, ReplContext, ReplFactory } from './stepWorker.js';
export { History, HISTORY_METHODS, HISTORY_LIMITS } from './history.js';
export { validateSchema } from './schema.js';
export { SpanRunner, applyPatches, isFatalCode } from './span.js';
export type { AbortReason, TraceEntry, SpanRunnerOptions, EmitExtra } from './span.js';
export { FakeRepl, FakeLLM, FakeLedger, FakeWriteGuard, liveWriteGuard } from './fakes.js';
export type { ScriptedExec, ExecReply, FakeReply } from './fakes.js';

export { Broker, SubInvokeDenied, actionHashOf, idemKeyOf, composeRedactors, BROKER_LIMITS, INVOKE_TOOL, CHECKPOINT_TOOL, HOST_GATE_ACTIONS, hostGateActionOf } from '../broker/broker.js';
export { sandboxCallbacks } from '../broker/sandboxBridge.js';
export type { SandboxSubInvoke, SandboxCheckpoint, SandboxCallbacks } from '../broker/sandboxBridge.js';
export type { BrokerOptions, BrokeredResult, ExecSession, ExecReport, Suspension, SubInvokeRequest, SubInvokeResult, BrokerErrorCode, TaintInfo, EffectRecord } from '../broker/broker.js';
export { HandleTable, HandleError } from '../broker/handles.js';

export { serializeInputs, redact, redactJson, redactorFor, toSafeJson, safeStringify, wrapUntrusted, escapeUntrusted, newNonce, truncate, SERIALIZER_LIMITS } from '../protocol/serializer.js';
export type { SerializeView, Serialized } from '../protocol/serializer.js';
export { parseProgram, PARSER_LIMITS } from '../protocol/parser.js';
export type { ParseResult } from '../protocol/parser.js';
export { workerSystemPrompt, renderTask, STANDARD_STUBS, EXAMPLE_PROGRAM, HOST_FUNCTION_BINDINGS, CHECKPOINT_KEY_RE } from '../protocol/prompts.js';
export type { StubDoc, SystemPromptOptions } from '../protocol/prompts.js';

export * from '../tools/index.js';
