// Deck UI sounds for the desktop app.
//
// On the Deck, Steam's own focus engine plays a click for every navigation,
// activation and back — the plugin only ever asks for the handful of sounds
// Steam has no opinion about (tab transitions, opening the settings modal). The
// desktop shim replaces that focus engine with its own (gamepad.ts), so the
// ambient sounds have to be played here or the app is silent.
//
// Files are Steam's: the backend serves them out of the local Steam install at
// /sounds/<name>.wav (see server.py). No Steam installed → 404 → silence, which
// is the intended graceful degradation, not a bug to fix.

export const SOUND_BASE = "/sounds/";

// index.tsx's playSteamSound reads this instead of steamloopback.host, so the
// plugin file stays byte-identical between the Deck and the desktop build.
(window as any).__ludoSoundBase = SOUND_BASE;

// One <audio> per sound, cloned per play so overlapping presses stack rather
// than cutting each other off. The originals are never played, only cloned.
const cache: Record<string, HTMLAudioElement> = {};

// Sounds are ambient decoration: a decode failure, a missing file or a blocked
// autoplay must never interrupt navigation, so everything here is swallowed.
export function playUiSound(name: string, volume = 1) {
  try {
    let base = cache[name];
    if (!base) {
      base = new Audio(`${SOUND_BASE}${name}.wav`);
      base.preload = "auto";
      cache[name] = base;
    }
    const a = base.cloneNode(true) as HTMLAudioElement;
    a.volume = volume;
    void a.play?.();
  } catch { /* no audio → silent */ }
}

// Steam's names for the events this shim generates. Kept as one table so the
// mapping is reviewable in a single place rather than spread over call sites.
const NAMES = {
  navigate: "deck_ui_navigation",
  activate: "deck_ui_default_activation",
  back: "deck_ui_out_of_game_detail",
  modalOpen: "deck_ui_show_modal",
  modalClose: "deck_ui_hide_modal",
  toast: "deck_ui_toast",
} as const;

export type UiSound = keyof typeof NAMES;

// The navigation tick fires on every d-pad step including held-repeat, so it
// sits well below the deliberate one-off sounds; Steam mixes it the same way.
const VOLUME: Partial<Record<UiSound, number>> = { navigate: 0.55 };

// Activation is reachable three ways for the same press — the pad's OK, the
// synthetic click it dispatches, and a Focusable's own Enter handler — and
// which ones fire depends on the control. Rather than make each call site
// reason about the others, collapse anything repeated inside one press window.
const DEDUPE_MS = 70;
const lastPlayed: Partial<Record<UiSound, number>> = {};

export function playSound(kind: UiSound) {
  const now = Date.now();
  if (now - (lastPlayed[kind] ?? 0) < DEDUPE_MS) return;
  lastPlayed[kind] = now;
  playUiSound(NAMES[kind], VOLUME[kind] ?? 1);
}

// Real (isTrusted) clicks — the mouse path. The shim's own programmatic
// .click() after a pad press is untrusted, and is sounded by gamepad.ts, so
// this listener can't double it; keyboard-activated clicks ARE trusted and land
// here, where the dedupe above merges them with the Focusable's Enter handler.
export function startSound() {
  window.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    const t = e.target as HTMLElement | null;
    // Ignore clicks on dead space; only sound something actually actionable.
    if (t?.closest("a,button,[tabindex],[role=button]")) playSound("activate");
  }, true);
}
