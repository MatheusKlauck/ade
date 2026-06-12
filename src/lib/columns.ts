/** Canonical kanban column names. The backend seeds exactly these five
 * columns; every UI lookup/comparison goes through these consts so a stray
 * string literal can't silently break a code path. */
export const COL_BACKLOG = "Backlog";
export const COL_DOING = "Doing";
export const COL_PAUSED = "Paused";
export const COL_PR = "PR";
export const COL_DONE = "Done";

/** Display order for board columns. */
export const COLUMN_ORDER: string[] = [
  COL_BACKLOG,
  COL_DOING,
  COL_PAUSED,
  COL_PR,
  COL_DONE,
];
