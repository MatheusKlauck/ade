-- Gestor #38 (plan_issues border): proposals produced by the intake LLM, held
-- for batch human approval before deterministic creation (PLANO §5). Extends the
-- §5 sketch with acceptance_json + priority (the #38 output contract).
CREATE TABLE issue_proposal (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES gestor_job(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL,
  ord             INTEGER NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  labels_json     TEXT,
  depends_on_json TEXT,
  acceptance_json TEXT,
  priority        TEXT,
  status          TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','created')),
  card_id         TEXT
);
CREATE INDEX idx_proposal_job ON issue_proposal(job_id, ord);
