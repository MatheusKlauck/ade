// Wire @monaco-editor/react to the locally-bundled monaco-editor instead of its
// default CDN fetch — a Tauri desktop app can't assume network access. Importing
// this module once (side effect) configures the loader and the web worker.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// Only the core editor worker is provided. Language workers (ts/json/css/html)
// add features we don't need for a read-only diff viewer; routing everything to
// the editor worker keeps the bundle lean and avoids 404s.
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });

/** Map a file path to a Monaco language id. Falls back to plaintext. */
export function languageFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    rs: "rust",
    json: "json",
    css: "css",
    html: "html",
    md: "markdown",
    py: "python",
    toml: "ini",
    yaml: "yaml",
    yml: "yaml",
    sh: "shell",
    sql: "sql",
  };
  return map[ext] ?? "plaintext";
}
