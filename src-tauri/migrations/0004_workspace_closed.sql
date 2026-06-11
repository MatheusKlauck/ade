-- Soft-close support: NULL = open, RFC3339 timestamp = closed.
-- Closed workspaces are hidden from the list but keep their board/cards so
-- reopening the same folder restores them.
ALTER TABLE workspace ADD COLUMN closed_at TEXT;
