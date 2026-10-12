// Child process of sqlite.concurrent.test.ts: one SqliteLedger of its own on the database file given in
// argv[2]. Commands arrive on the Node IPC channel and are answered there. The ledger's test barrier is
// synchronous (better-sqlite3 transactions are), so while a transaction is held this process cannot service
// its event loop: the barrier reports on a dedicated pipe (fd 4) with a blocking write and waits for its
// release with a blocking read of one line from another (fd 3).
import { readSync, writeSync } from 'node:fs';
import { approvalGrantedEvent } from '@tecera/contracts';
import { SqliteLedger } from '../dist/sqlite.js';

const RELEASE_FD = 3;
const REPORT_FD = 4;
const name = process.argv[3] ?? 'child';

/** Barrier points this process stops at (set per command); every point reached is reported. */
let holdAt = new Set();
let clock = null;

function report(line) {
  writeSync(REPORT_FD, `${line}\n`);
}

/** One line from the release pipe, read byte by byte with blocking reads. */
function releaseLine() {
  const one = Buffer.alloc(1);
  let line = '';
  for (;;) {
    let n;
    try {
      n = readSync(RELEASE_FD, one, 0, 1, null);
    } catch (e) {
      if (e && (e.code === 'EAGAIN' || e.code === 'EINTR')) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        continue;
      }
      throw e;
    }
    if (n !== 1) throw new Error('release pipe closed');
    if (one[0] === 0x0a) return line;
    line += String.fromCharCode(one[0]);
  }
}

function barrier(point) {
  report(`at ${point}`);
  if (!holdAt.has(point)) return;
  // 'go', or 'clock=<ms>' to move this process's clock while it is inside the transaction.
  const line = releaseLine();
  if (line.startsWith('clock=')) clock = Number(line.slice(6));
  report(`released ${point}`);
}

const ledger = new SqliteLedger(process.argv[2], { testBarrier: barrier, now: () => (clock === null ? Date.now() : clock) });

const ops = {
  reserve: (a) => ledger.reserve(a.pool, a.amount, a.runId, a.idemKey),
  approve: (a) =>
    ledger.approve(
      a.requestId,
      a.approver,
      a.sessionId,
      a.at,
      approvalGrantedEvent({ id: a.auditId, at: a.at, requestId: a.requestId, runId: a.runId, sessionId: a.sessionId, actionHash: a.actionHash, approver: a.approver, trace: { goalId: 'g', intentionId: 'i', stepId: 's' } }),
    ),
  consume: (a) => ledger.consume(a.requestId, a.actionHash, a.sessionId, a.idemKey, a.at),
  lease: (a) => ledger.lease(a.resource, a.holder, a.ttlMs),
  renew: (a) => ledger.renew(a.lease, a.ttlMs),
  release: (a) => ledger.release(a.lease),
  getApproval: (a) => ledger.getApproval(a.requestId),
  rawExec: (a) => ledger.rawExec(a.sql),
};

process.on('message', (m) => {
  if (m.cmd === 'exit') {
    ledger.close();
    process.exit(0);
  }
  holdAt = new Set(m.holdAt ?? []);
  if (m.clock !== undefined) clock = m.clock;
  // Reported on the pipe BEFORE the operation starts: the parent knows this process is about to contend.
  report(`attempting ${m.cmd}`);
  Promise.resolve()
    .then(() => ops[m.cmd](m.args ?? {}))
    .then(
      (value) => process.send({ id: m.id, ok: true, value: value ?? null }),
      (e) => process.send({ id: m.id, ok: false, error: String(e?.message ?? e), code: e?.code ?? null }),
    );
});

process.send({ ready: name });
