-- Gestor S1 (épico #40, issue #41): the two central tables that are the single
-- source of Gestor state. `agent_task` = lifecycle of one card's automated run;
-- `agent_event` = the auditable feed (D8: every gestor action is an event).
-- gestor_job / issue_proposal (PLANO §5) land in their own slices (#43/#38).

CREATE TABLE agent_task (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  card_id       TEXT NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  state         TEXT NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 1,
  max_attempts  INTEGER NOT NULL,
  branch        TEXT,
  worktree_path TEXT,
  window_id     TEXT,
  events_file   TEXT,
  fail_reason   TEXT,
  last_event_at TEXT,
  started_at    TEXT,
  finished_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE agent_event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  task_id      TEXT,
  job_id       TEXT,
  ts           TEXT NOT NULL,
  kind         TEXT NOT NULL,
  level        TEXT NOT NULL DEFAULT 'info',
  payload_json TEXT,
  cost_usd     REAL,
  num_turns    INTEGER,
  duration_ms  INTEGER
);

CREATE INDEX idx_event_ws_ts ON agent_event(workspace_id, ts DESC);
CREATE INDEX idx_task_ws_state ON agent_task(workspace_id, state);
