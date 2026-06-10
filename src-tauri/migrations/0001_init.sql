CREATE TABLE workspace (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  root_path     TEXT NOT NULL,
  github_owner  TEXT,
  github_repo   TEXT,
  startup_command TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE board_column (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  position      INTEGER NOT NULL
);

CREATE TABLE card (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  column_id     TEXT NOT NULL REFERENCES board_column(id),
  title         TEXT NOT NULL,
  body_preview  TEXT,
  position      REAL NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('local','github')),
  github_issue_number INTEGER,
  github_state  TEXT CHECK (github_state IN ('open','closed')),
  assignee      TEXT,
  labels_json   TEXT,
  remote_updated_at TEXT,
  terminal_window_id TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_card_board ON card(workspace_id, column_id, position);
CREATE UNIQUE INDEX idx_card_issue ON card(workspace_id, github_issue_number)
  WHERE github_issue_number IS NOT NULL;

CREATE TABLE outbox (
  card_id       TEXT PRIMARY KEY REFERENCES card(id) ON DELETE CASCADE,
  intent        TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  base_remote_updated_at TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE sync_state (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  last_sync     TEXT,
  list_etag     TEXT
);

CREATE TABLE setting  (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE ui_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
