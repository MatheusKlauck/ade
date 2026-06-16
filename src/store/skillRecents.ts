import { create } from "zustand";

// Tracks how often each skill is used, surfaced as the quick-launch "Most used"
// tray ranked by count. Fed from two places: dragging a skill row/pill out of
// the sidebar, AND typing `/skill` straight into a Claude Code terminal (the
// common case the old drag-only tracker missed). Local-only (localStorage).
const STORE_KEY = "ade.skills.recents";
// Cap the stored map so it can't grow without bound as one-off skills accrue.
const MAX_STORED = 40;
// How many ranked skills the quick-launch tray shows.
export const TRAY_MAX = 8;

type CountMap = Record<string, number>;

function pruneTop(map: CountMap, n: number): CountMap {
  const entries = Object.entries(map);
  if (entries.length <= n) return map;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, n));
}

// Accepts both the current count-map shape and the legacy MRU string[] (seeded
// at count 1, newest-first so earlier entries rank higher), so existing recents
// survive the upgrade.
function load(): CountMap {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    if (Array.isArray(raw)) {
      const out: CountMap = {};
      raw.forEach((name, i) => {
        if (typeof name === "string") out[name] = raw.length - i;
      });
      return out;
    }
    if (raw && typeof raw === "object") {
      const out: CountMap = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function persist(map: CountMap) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(map));
  } catch {
    // localStorage can throw in private mode; the tray is a nicety, so swallow.
  }
}

interface SkillRecentsState {
  counts: CountMap;
  // Names of skills the sidebar has scanned, so terminal-typed `/foo` is only
  // counted when `foo` is a real skill (not `/clear`, `/help`, a typo, …).
  known: Set<string>;
  setKnown: (names: string[]) => void;
  record: (name: string) => void;
}

export const useSkillRecentsStore = create<SkillRecentsState>((set, get) => ({
  counts: load(),
  known: new Set(),
  setKnown: (names) => set({ known: new Set(names) }),
  record: (name) => {
    if (!get().known.has(name)) return;
    set((s) => {
      const next = pruneTop({ ...s.counts, [name]: (s.counts[name] ?? 0) + 1 }, MAX_STORED);
      persist(next);
      return { counts: next };
    });
  },
}));

// Skill names ranked by use count, highest first. Ties keep object order.
export function rankedSkills(counts: CountMap, n: number): string[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name]) => name);
}

// Pull a leading skill name out of a typed command line: `/plan foo` → "plan",
// `/ponytail:ponytail` → "ponytail:ponytail". null when the line isn't a slash
// command. ponytail: the `record` guard rejects unknown names, so over-matching
// here is harmless.
export function skillNameFromLine(line: string): string | null {
  const m = /^\/([a-z0-9][a-z0-9:_-]*)/i.exec(line.trim());
  return m ? m[1] : null;
}
