import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

/** Selector for the trap: only currently-operable controls, so Tab never lands
 * on a disabled button at either end of the cycle. */
const TRAP_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Selector for the initial-focus probe (no :disabled filter — matches the
 * historical Settings behavior of grabbing the first focusable candidate). */
const INITIAL_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Shared modal focus scaffolding: pull focus into the dialog on open, return
 * it to whatever was focused before on close, close on Esc, and trap Tab so
 * keyboard focus can't escape behind the scrim.
 *
 * Returns a `panelRef` to attach to the dialog panel element and a
 * `handleKeyDown` to wire to its `onKeyDown`. By default the first focusable
 * descendant (or the panel itself) receives initial focus; pass
 * `initialFocusRef` to direct it elsewhere (e.g. a Cancel button so a
 * reflexive Enter never triggers a destructive action). */
export function useModalFocus(
  onDismiss: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>
) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Modal focus management: pull focus into the dialog on open, return it to
  // whatever was focused before (the opener) on close. Runs once per mount.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    if (initialFocusRef?.current) {
      initialFocusRef.current.focus();
    } else {
      const panel = panelRef.current;
      const first = panel?.querySelector<HTMLElement>(INITIAL_SELECTOR);
      (first ?? panel)?.focus();
    }
    return () => restoreFocusRef.current?.focus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc dismisses; Tab is trapped so keyboard focus can't escape the panel.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onDismiss();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = panel.querySelectorAll<HTMLElement>(TRAP_SELECTOR);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onDismiss]
  );

  return { panelRef, handleKeyDown };
}
