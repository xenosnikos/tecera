# Threat model (kernel-first slice)

The authoritative threat model lives in `docs/design/security.md` §1 (assets, trust boundaries, attacker
capabilities, top-12 attacks with controls), §2 (sandbox profile), §3 (RPC), §4 (ledger/approvals and the
crash-recovery matrix), §5 (verify/review gates), §6 (adversarial test suite) and §7 (secrets).

Summary of boundaries, highest trust first: host OS → supervisor (`@tecera/loop` + `worker` + `policy` +
`ledger`; holds secrets as handles) → broker (sole writer to repo and ledger) → sandbox child (untrusted,
model-written JS) → model provider (untrusted content) → repo under edit (untrusted content incl. tests and
git hooks) → verify process (runs untrusted repo code) → tool outputs (untrusted data).

Invariants every change must keep:
1. No model-written code executes outside a disposable restricted child; the child reaches the world only
   through broker RPC with HMAC exec-scoped handles.
2. Authority is derived from `(handle, method, args)` + policy, never from text, provenance labels, or a
   model's claim.
3. Capabilities and budgets only narrow down the invoke tree; reservations precede execution.
4. Completion requires an environment check in a separate process plus a foreign-provider review over a
   frozen packet; fingerprints D1 = D2 = D3 = committed tree.
5. Approvals are durable, one-use, bound to `{requestId, actionHash, session, requester, approver, expiry}`,
   with requester ≠ approver and authenticated ingress.
6. Secrets exist only as `SecretHandle`s in the supervisor; every string crossing to a prompt, log, ledger
   row, review packet or reflex state passes the redacting serializer; canary tests enforce it.
7. Ledger writes are append-only and hash-chained; a failed write blocks the state transition.
