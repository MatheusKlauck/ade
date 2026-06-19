//! Turn-state shims for the non-Claude coding agents (pi, opencode), the
//! counterpart to `claude_hooks.rs`. Each shim emits the same
//! `OSC 9;ade:<kind>:<state>[:<sid>]` marker Claude's hooks do, so
//! `term_monitor`'s scanner drives the pane's comet/veil/pulse uniformly.
//!
//! - **pi** uses a per-invocation extension (`pi -e <file>`, see
//!   `tmux::pi_wrapper_snippet`) — non-invasive, loaded only in ADE panes.
//! - **opencode** has no per-invocation plugin flag, so its plugin lives in the
//!   global plugin dir but is INERT unless `$ADE_TTY` is set (exported by ADE's
//!   `opencode` wrapper) — so it never fires outside ADE's panes.
//!
//! Both write the marker straight to `$ADE_TTY` (the pane pty `pipe-pane`
//! captures), best-effort: a shim must never fail or stall the agent.

use std::path::PathBuf;

/// Stable path of the pi turn-state extension, loaded via `pi -e <this>`.
pub fn pi_extension_path() -> PathBuf {
    std::env::temp_dir().join("ade-pi-turnstate.ts")
}

/// pi extension: maps `agent_start`/`agent_end` to ADE turn markers. pi has no
/// idle/notification event, so there's no `waiting` pulse — `turn-end` clears
/// the busy state. Session id is parsed out of the session file path.
const PI_EXTENSION: &str = r#"// ADE turn-state shim for pi (auto-written; do not edit).
import { appendFileSync } from "node:fs";
export default function (pi) {
  const tty = process.env.ADE_TTY;
  if (!tty) return;
  const emit = (state, ctx) => {
    try {
      const f = ctx?.sessionManager?.getSessionFile?.() ?? "";
      const m = /([0-9a-fA-F-]{36})\.jsonl$/.exec(f);
      appendFileSync(tty, `\x1b]9;ade:pi:${state}:${m ? m[1] : ""}\x07`);
    } catch {}
  };
  pi.on("agent_start", async (_e, ctx) => emit("turn-start", ctx));
  pi.on("agent_end", async (_e, ctx) => emit("turn-end", ctx));
}
"#;

/// opencode plugin: maps streaming/tool activity to `turn-start`, `permission.asked`
/// to `waiting`, and `session.idle` to `turn-end`. `busy` debounces the many
/// streaming events to one `turn-start` per turn. Inert unless `$ADE_TTY` is set.
const OPENCODE_PLUGIN: &str = r#"// ADE turn-state shim for opencode (auto-written; do not edit).
import { appendFileSync } from "node:fs";
const TTY = process.env.ADE_TTY;
function sid(event) {
  const p = event?.properties || {};
  return p?.info?.id || p.sessionID || p.sessionId || p.session_id || p.id ||
    event?.sessionID || event?.id || "";
}
export const ade = async () => {
  if (!TTY) return {};
  let busy = false;
  const emit = (state, id) => {
    try { appendFileSync(TTY, `\x1b]9;ade:opencode:${state}:${id || ""}\x07`); } catch {}
  };
  return {
    event: async ({ event }) => {
      const t = event?.type ?? "";
      if (t === "session.idle") { busy = false; emit("turn-end", sid(event)); }
      else if (t === "permission.asked") { emit("waiting", sid(event)); }
      else if (t === "message.updated" || t === "message.part.updated" || t === "tool.execute.before") {
        if (!busy) { busy = true; emit("turn-start", sid(event)); }
      }
    },
  };
};
"#;

/// Write the pi extension file. Best-effort; a failure just means no pi visuals.
pub fn ensure_pi() {
    let _ = std::fs::write(pi_extension_path(), PI_EXTENSION);
}

/// Write the opencode plugin into its global plugin dir (auto-discovered). The
/// `$ADE_TTY` guard keeps it inert in non-ADE opencode sessions. Best-effort.
pub fn ensure_opencode() {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let dir = PathBuf::from(&home).join(".config/opencode/plugins");
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(dir.join("ade-turnstate.js"), OPENCODE_PLUGIN);
    }
}
