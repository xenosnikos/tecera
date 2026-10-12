/** Capabilities and provisioning: the probe, the local provisioner, the inventory, the expiry sweep. */
export { ConnectionProbe, storeAuthResolver, untrustedProbe, PROBE_TIMEOUT_EXIT, PROBE_UNTRUSTED_EXIT, DEFAULT_PROBE_TIMEOUT_SEC } from './probe.js';
export type { AuthResolver, Connections, ConnectionProbeOptions, ProbeDetail } from './probe.js';
export { LocalProvisioner, ProvisioningRefused, allowanceProblem, locatorWithin, resourcesRoot, teardownFor, stopStub, RESOURCES_ENV, LOCAL_KINDS, TEARDOWN_REFUSED } from './provisioner.js';
export type { LocalKind, LocalProvisionerOptions, ProvisionNeed, ReleaseGuard, ReleaseResult, StubKill } from './provisioner.js';
export type { HttpStubConfig, StubRoute, StubRequest } from './httpStub.js';
export { buildInventory, requiredCapabilities } from './inventory.js';
export type { Inventory, InventoryDecision, InventoryInput } from './inventory.js';
export { capabilityProbedEvent, resourceProvisionedEvent, resourceReleasedEvent, resourceTransferredEvent } from './events.js';
export type { EventBase } from './events.js';
export { releaseExpired, releaseRecorded } from './sweep.js';
export type { ReleaseContext, Released, SweepResult } from './sweep.js';
export { repositoryFacts, capabilityAccess, runtimeEnvironment, hostBinding, withStandIns, RUNTIME_BUILTINS } from './access.js';
export type { CapabilityAccessInput } from './access.js';
