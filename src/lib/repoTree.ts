import type { ChangedFile } from "./ipc";

// Folder tree for the Repo view's changed-file list. Pure (no Monaco/DOM) so it
// stays unit-testable in a node environment.

interface Node {
  name: string;
  path: string;
  file?: ChangedFile; // set only on leaves
  children: Map<string, Node>;
}

export type Row =
  | { type: "dir"; path: string; label: string; depth: number }
  | { type: "file"; file: ChangedFile; name: string; depth: number };

function buildTree(files: ChangedFile[]): Node {
  const root: Node = { name: "", path: "", children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    parts.forEach((part, i) => {
      let next = cur.children.get(part);
      if (!next) {
        next = { name: part, path: parts.slice(0, i + 1).join("/"), children: new Map() };
        cur.children.set(part, next);
      }
      if (i === parts.length - 1) next.file = f;
      cur = next;
    });
  }
  return root;
}

// Collapse a single-child directory chain (src-tauri → src → ipc) into one row.
function compact(node: Node): { label: string; node: Node } {
  let label = node.name;
  let n = node;
  while (n.children.size === 1) {
    const only = [...n.children.values()][0];
    if (only.file) break;
    label += "/" + only.name;
    n = only;
  }
  return { label, node: n };
}

const byName = (a: Node, b: Node) => a.name.localeCompare(b.name);

function flatten(node: Node, depth: number, collapsed: Set<string>, out: Row[]) {
  const entries = [...node.children.values()];
  for (const d of entries.filter((e) => !e.file).sort(byName)) {
    const { label, node: deep } = compact(d);
    out.push({ type: "dir", path: deep.path, label, depth });
    if (!collapsed.has(deep.path)) flatten(deep, depth + 1, collapsed, out);
  }
  for (const f of entries.filter((e) => e.file).sort(byName)) {
    out.push({ type: "file", file: f.file!, name: f.name, depth });
  }
}

/** Changed files → flat list of tree rows (dirs + files), honoring collapse. */
export function treeRows(files: ChangedFile[], collapsed: Set<string>): Row[] {
  const out: Row[] = [];
  flatten(buildTree(files), 0, collapsed, out);
  return out;
}
