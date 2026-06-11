-- Per-workspace settings. Replaces the global `setting` table as the live
-- store: every value (theme, accent, startup command/delay, sync interval,
-- github token display, auto_branch) is now scoped to a single workspace.
-- The old `setting` table is kept only as the one-time seed source below.
CREATE TABLE workspace_setting (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

-- Seed every existing workspace with the current global values so upgrading
-- users keep their settings per workspace. New workspaces created later have
-- no rows and fall back to code defaults.
INSERT INTO workspace_setting (workspace_id, key, value)
  SELECT w.id, s.key, s.value
  FROM workspace w CROSS JOIN setting s;
