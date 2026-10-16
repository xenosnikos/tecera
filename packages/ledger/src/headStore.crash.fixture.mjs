// Child process of headStore.test.ts: one write on a hardened ledger (database argv[2], checkpoint directory
// argv[3]) that SIGKILLs itself at the head barrier point argv[4], so nothing after that point runs: no
// rollback handler, no finally, no journal cleanup. argv[5] is the write: 'event', 'evidence' or 'approve'.
import { approvalGrantedEvent, event } from '@tecera/contracts';
import { HeadStore } from '../dist/headStore.js';
import { SqliteLedger } from '../dist/sqlite.js';

const [db, dir, point, op] = process.argv.slice(2);
const head = new HeadStore(dir, { barrier: (p) => (p === point ? process.kill(process.pid, 'SIGKILL') : undefined) });
const ledger = new SqliteLedger(db, { head, journalMode: 'delete' });
const at = 1_700_000_000_000;
if (op === 'event') {
  await ledger.append(event('belief.added', { id: 'crash-ev', at, actor: { kind: 'system', id: 'crash' }, runId: 'r1', trace: {}, payload: { key: 'crash', value: 1 } }));
} else if (op === 'evidence') {
  await ledger.evidence({ key: 'crash-evidence', kind: 'gate.verify', runId: 'r1', body: { exitCode: 0 } });
} else if (op === 'approve') {
  const audit = approvalGrantedEvent({ id: 'crash-grant', at, requestId: 'ap1', runId: 'r1', sessionId: 's1', actionHash: 'h1', approver: { kind: 'human', id: 'bob' }, trace: { goalId: 'g1', intentionId: 'i1', stepId: 'pr' }, reason: '' });
  await ledger.approve('ap1', { kind: 'human', id: 'bob' }, 's1', at, audit);
} else throw new Error(`unknown op ${op}`);
process.stdout.write('done\n');
