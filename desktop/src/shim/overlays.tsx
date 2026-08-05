// Modal + toast plumbing, shared by the ui and api shims.
//
// Lives in its own module because showModal/ModalRoot come from @decky/ui while
// toaster comes from @decky/api, and openFilePicker (api) needs to open a modal
// (ui) — routing both through here avoids a circular import.
import { useEffect, useState, type ReactNode } from "react";
import { inMouseMode } from "./gamepad";
import { playSound } from "./sound";

// ── Modals ──────────────────────────────────────────────────────────────────

export type ModalHandle = { Close: () => void };

type ModalEntry = {
  id: number;
  render: (h: ModalHandle) => ReactNode;
  // The controller-focused element at open time, restored when this modal
  // closes so the pad returns to the opener (e.g. the platform row that
  // launched the core picker) instead of re-seeding onto the first focusable.
  opener: HTMLElement | null;
};

let modalSeq = 0;
const modals: ModalEntry[] = [];
const modalSubs = new Set<() => void>();
const notifyModals = () => modalSubs.forEach((f) => f());

// Restore focus to a modal's opener after React has committed the unmount.
// Guard on still-connected + not display:none; a plain .focus() re-triggers the
// gamepad marker mirror so the highlight follows.
function restoreOpener(el: HTMLElement | null) {
  if (!el || inMouseMode()) return;
  requestAnimationFrame(() => {
    if (!el.isConnected || (el.offsetWidth === 0 && el.offsetHeight === 0)) return;
    try { el.focus({ preventScroll: false } as any); } catch { /* gone */ }
  });
}

function popModal(id: number) {
  const i = modals.findIndex((m) => m.id === id);
  if (i === -1) return;
  const [entry] = modals.splice(i, 1);
  playSound("modalClose");
  notifyModals();
  restoreOpener(entry.opener);
}

/**
 * Decky passes the modal element a `closeModal` prop. We clone that contract:
 * the caller supplies a render fn, we hand it a handle whose Close() pops it.
 */
export function pushModal(render: (h: ModalHandle) => ReactNode): ModalHandle {
  const id = ++modalSeq;
  const handle: ModalHandle = { Close: () => popModal(id) };
  const ae = document.activeElement as HTMLElement | null;
  modals.push({ id, render, opener: ae && ae !== document.body ? ae : null });
  playSound("modalOpen");
  notifyModals();
  return handle;
}

export function ModalHost() {
  const [, setRev] = useState(0);
  useEffect(() => {
    const bump = () => setRev((n) => n + 1);
    modalSubs.add(bump);
    return () => void modalSubs.delete(bump);
  }, []);

  // Tell the page a modal is up, so chrome outside the scrim can respond to it
  // — the footer legend swaps its translucent resting look for an opaque one so
  // it stays legible against the blurred backdrop. Body class rather than a
  // context: the legend is a sibling of ModalHost, not a descendant.
  useEffect(() => {
    document.body.classList.toggle("shim-modal-open", modals.length > 0);
  });
  useEffect(() => () => document.body.classList.remove("shim-modal-open"), []);

  if (!modals.length) return null;
  return (
    <>
      {modals.map((m) => {
        const handle: ModalHandle = { Close: () => popModal(m.id) };
        return (
          <div className="shim-modal-scrim" key={m.id}>
            {m.render(handle)}
          </div>
        );
      })}
    </>
  );
}

// ── Toasts ──────────────────────────────────────────────────────────────────

export type ToastOpts = {
  title?: ReactNode;
  body?: ReactNode;
  // Decky's toast art slot — we render it leading the text, same as Steam.
  // Callers pass a node that may render nothing (e.g. a game with no cover),
  // so the layout has to survive an empty logo without leaving a gap.
  logo?: ReactNode;
  duration?: number;
  critical?: boolean;
  onClick?: () => void;
  // Accepted for parity with Decky's ToastData so shared callers typecheck.
  // The shim's own chime is unconditional; opting out isn't wired up here.
  playSound?: boolean;
};

type ToastEntry = ToastOpts & { id: number };

let toastSeq = 0;
let toasts: ToastEntry[] = [];
const toastSubs = new Set<() => void>();
const notifyToasts = () => toastSubs.forEach((f) => f());

// Mirrors Decky's toaster.toast return value: a handle whose dismiss() takes the
// toast down early. Needed for the long-lived ones (the library fetch strip),
// which have no meaningful duration up front — they end when the work ends.
export function pushToast(opts: ToastOpts) {
  const id = ++toastSeq;
  toasts = [...toasts, { ...opts, id }];
  playSound("toast");
  notifyToasts();
  const dismiss = () => {
    if (!toasts.some((t) => t.id === id)) return;
    toasts = toasts.filter((t) => t.id !== id);
    notifyToasts();
  };
  const ms = opts.duration ?? 5000;
  // A non-finite duration means "until dismissed". Passing it to setTimeout
  // would be worse than useless: a non-finite delay is coerced to 0, so the
  // toast meant to stay longest would be the one that vanished instantly.
  if (Number.isFinite(ms)) window.setTimeout(dismiss, ms);
  return { data: opts, dismiss };
}

// Notification-overlay corner, chosen in Settings (desktop-only). Persisted in
// localStorage so it survives restarts; the settings page dispatches
// `romm:toastpos` on change so the host repositions live without a reload.
const TOAST_POS_KEY = "romm:toastPos";
const TOAST_POSITIONS = ["top-right", "top-left", "bottom-right", "bottom-left"];
function readToastPos(): string {
  try {
    const v = localStorage.getItem(TOAST_POS_KEY);
    if (v && TOAST_POSITIONS.includes(v)) return v;
  } catch { /* private mode / no storage */ }
  return "bottom-right";
}

export function ToastHost() {
  const [, setRev] = useState(0);
  const [pos, setPos] = useState(readToastPos);
  useEffect(() => {
    const bump = () => setRev((n) => n + 1);
    toastSubs.add(bump);
    const onPos = () => setPos(readToastPos());
    window.addEventListener("romm:toastpos", onPos);
    return () => {
      toastSubs.delete(bump);
      window.removeEventListener("romm:toastpos", onPos);
    };
  }, []);

  return (
    <div className="shim-toast-host" data-pos={pos}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className={"shim-toast" + (t.critical ? " shim-toast-critical" : "")
            // Only a toast that actually does something gets the pointer — most
            // are pure notifications and shouldn't look pressable.
            + (t.onClick ? " shim-toast-clickable" : "")}
          onClick={t.onClick}
        >
          {t.logo ? <div className="shim-toast-logo">{t.logo}</div> : null}
          <div className="shim-toast-text">
            {t.title ? <div className="shim-toast-title">{t.title}</div> : null}
            {t.body ? <div className="shim-toast-body">{t.body}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
