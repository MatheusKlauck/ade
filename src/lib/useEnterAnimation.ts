import { useEffect, useRef, useState } from "react";

/**
 * Tracks which ids are *newly added since the first render*, so only genuinely
 * new list items get an entrance animation — never the initial mount (which
 * would be page-load choreography). A card synced in from GitHub or a terminal
 * spun up from a card → Doing animates; the items already present when the view
 * first painted do not.
 *
 * `isEntering(id)` is computed at render time (so a new item carries the
 * animation class on its very first paint — no opacity flicker) and stays true
 * until the item reports `onEntered` from its `animationend`, so an intervening
 * re-render can't cut the animation short.
 *
 * Pass `resetKey` (e.g. the active workspace id) for a list whose host
 * component persists across context switches — when it changes, the next set of
 * ids is re-seeded as "existing" instead of animating in. Lists whose host
 * remounts per context (keyed columns, etc.) don't need it.
 */
export function useEnterAnimation(
  ids: string[],
  resetKey?: string | null
): { isEntering: (id: string) => boolean; onEntered: (id: string) => void } {
  const seen = useRef<Set<string>>(new Set());
  const initialized = useRef(false);
  const resetRef = useRef(resetKey);
  const [animating, setAnimating] = useState<Set<string>>(() => new Set());

  // A pending reset (resetKey changed) suppresses entrances for this render;
  // the effect below re-seeds `seen` from the incoming ids.
  const switching = resetRef.current !== resetKey;

  const isNew = (id: string) =>
    !switching && initialized.current && !seen.current.has(id);

  useEffect(() => {
    if (!initialized.current) {
      ids.forEach((id) => seen.current.add(id));
      initialized.current = true;
      return;
    }
    if (resetRef.current !== resetKey) {
      seen.current = new Set(ids);
      resetRef.current = resetKey;
      setAnimating((cur) => (cur.size ? new Set() : cur));
      return;
    }
    const fresh: string[] = [];
    ids.forEach((id) => {
      if (!seen.current.has(id)) {
        seen.current.add(id);
        fresh.push(id);
      }
    });
    // Drop departed ids so a later re-add animates again.
    const present = new Set(ids);
    seen.current.forEach((id) => {
      if (!present.has(id)) seen.current.delete(id);
    });
    if (fresh.length) {
      setAnimating((cur) => {
        const next = new Set(cur);
        fresh.forEach((id) => next.add(id));
        return next;
      });
    }
  });

  const onEntered = (id: string) =>
    setAnimating((cur) => {
      if (!cur.has(id)) return cur;
      const next = new Set(cur);
      next.delete(id);
      return next;
    });

  return {
    isEntering: (id) => isNew(id) || animating.has(id),
    onEntered,
  };
}
