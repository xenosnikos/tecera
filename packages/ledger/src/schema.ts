/**
 * SQLite schema. Events, evidence and checkpoints are append-only at the schema level:
 * - BEFORE UPDATE / BEFORE DELETE triggers abort any rewrite or removal;
 * - BEFORE INSERT triggers abort an insert whose key already exists (events: seq, id, idem_key, hash;
 *   evidence: key, n; checkpoints: id). SQLite's REPLACE conflict resolution deletes the conflicting row
 *   WITHOUT firing DELETE triggers (unless recursive_triggers is on in that connection), so without these an
 *   `INSERT OR REPLACE` from any connection could rewrite a row in place.
 * Evidence rows are hash-chained (n, prev_hash, hash) and each is bound to the events head at its seq
 * (event_hash), so verifyChain detects a rewritten evidence row as well as a rewritten event.
 *
 * SCHEMA_SQL creates the tables; SCHEMA_POST_SQL (run after the column migration in SqliteLedger) creates
 * the indexes and triggers that depend on migrated columns.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,
  at            INTEGER NOT NULL,
  actor_kind    TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  run_id        TEXT,
  goal_id       TEXT,
  intention_id  TEXT,
  step_id       TEXT,
  plan_id       TEXT,
  payload       TEXT NOT NULL,
  idem_key      TEXT UNIQUE,
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind, seq);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
CREATE TRIGGER IF NOT EXISTS events_no_replace BEFORE INSERT ON events
WHEN EXISTS (SELECT 1 FROM events WHERE seq = NEW.seq OR id = NEW.id OR hash = NEW.hash OR (NEW.idem_key IS NOT NULL AND idem_key = NEW.idem_key))
BEGIN
  SELECT RAISE(ABORT, 'events are append-only: seq, id, idem_key or hash already exists');
END;

CREATE TABLE IF NOT EXISTS evidence (
  key         TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  digest      TEXT NOT NULL,
  body        TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  n           INTEGER,
  prev_hash   TEXT,
  hash        TEXT,
  event_hash  TEXT
);
CREATE TRIGGER IF NOT EXISTS evidence_no_update BEFORE UPDATE ON evidence BEGIN
  SELECT RAISE(ABORT, 'evidence is append-only');
END;
CREATE TRIGGER IF NOT EXISTS evidence_no_delete BEFORE DELETE ON evidence BEGIN
  SELECT RAISE(ABORT, 'evidence is append-only');
END;

CREATE TABLE IF NOT EXISTS budgets (
  run_id   TEXT NOT NULL,
  pool     TEXT NOT NULL,
  cap      REAL NOT NULL,
  enforce  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (run_id, pool)
);

CREATE TABLE IF NOT EXISTS reservations (
  id        TEXT PRIMARY KEY,
  run_id    TEXT NOT NULL,
  pool      TEXT NOT NULL,
  amount    REAL NOT NULL,
  actual    REAL,
  state     TEXT NOT NULL CHECK (state IN ('reserved','charged','released')),
  idem_key  TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS reservations_pool ON reservations(run_id, pool);

CREATE TABLE IF NOT EXISTS leases (
  resource       TEXT PRIMARY KEY,
  holder         TEXT NOT NULL,
  fencing_token  INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  request_id      TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  action_hash     TEXT NOT NULL,
  requester_kind  TEXT NOT NULL,
  requester_id    TEXT NOT NULL,
  reason          TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending','granted','denied','consumed','expired')),
  expires_at      INTEGER NOT NULL,
  approver_kind   TEXT,
  approver_id     TEXT,
  granted_at      INTEGER,
  denied_reason   TEXT,
  consumed_at     INTEGER,
  consume_idem    TEXT UNIQUE,
  granted_seq     INTEGER
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id      TEXT PRIMARY KEY,
  run_id  TEXT NOT NULL,
  key     TEXT NOT NULL,
  state   TEXT NOT NULL,
  digest  TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS checkpoints_no_update BEFORE UPDATE ON checkpoints BEGIN
  SELECT RAISE(ABORT, 'checkpoints are append-only');
END;
CREATE TRIGGER IF NOT EXISTS checkpoints_no_delete BEFORE DELETE ON checkpoints BEGIN
  SELECT RAISE(ABORT, 'checkpoints are append-only');
END;
CREATE TRIGGER IF NOT EXISTS checkpoints_no_replace BEFORE INSERT ON checkpoints
WHEN EXISTS (SELECT 1 FROM checkpoints WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'checkpoints are append-only: id already exists');
END;
`;

/** Indexes and triggers over columns that older ledgers gain through the migration. */
export const SCHEMA_POST_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS evidence_n ON evidence(n);
CREATE TRIGGER IF NOT EXISTS evidence_no_replace BEFORE INSERT ON evidence
WHEN EXISTS (SELECT 1 FROM evidence WHERE key = NEW.key OR (NEW.n IS NOT NULL AND n = NEW.n))
BEGIN
  SELECT RAISE(ABORT, 'evidence is append-only: key or n already exists');
END;
CREATE TRIGGER IF NOT EXISTS evidence_chained BEFORE INSERT ON evidence
WHEN NEW.n IS NULL OR NEW.hash IS NULL OR NEW.prev_hash IS NULL OR NEW.event_hash IS NULL
BEGIN
  SELECT RAISE(ABORT, 'evidence rows must be hash-chained (n, prev_hash, hash, event_hash)');
END;
`;
