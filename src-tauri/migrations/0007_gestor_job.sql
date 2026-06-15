-- Gestor S3 (#43): the gestor_job queue (PLANO §5). One row per LLM border run
-- (plan_issues / review_diff / diagnose_stall / release_notes), with the audit
-- columns D8 wants — input/output/error + cost/turns/duration. issue_proposal
-- (also in §5's 0006 block) lands with the plan_issues border, #38.
CREATE TABLE gestor_job (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('plan_issues','review_diff','diagnose_stall','release_notes')),
  state        TEXT NOT NULL CHECK (state IN ('queued','running','done','failed')),
  input_json   TEXT NOT NULL,
  output_json  TEXT,
  error        TEXT,
  cost_usd     REAL,
  num_turns    INTEGER,
  duration_ms  INTEGER,
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX idx_job_ws_state ON gestor_job(workspace_id, state);
