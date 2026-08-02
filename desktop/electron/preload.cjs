// Renderer-side gamepad bridge for the Electron shell.
//
// The GTK shell reads the controller natively with libmanette because
// WebKitGTK's W3C Gamepad API mangles Xbox-compatible pads over Bluetooth (d-pad
// and triggers collapse onto stick axes). Chromium's Gamepad API does NOT have
// that bug, so here we poll navigator.getGamepads() directly and drive the same
// `window.__rommGamepad` API that src/shim/gamepad.ts installs — no native
// module. If Chromium's mapping ever proves unreliable on some pad, this is the
// single place to swap in a node-hid/XInput fallback.
//
// Mapping cross-check — Chromium "standard" layout → GamepadButtonId, verified
// against the libmanette table in gamepad_bridge.py's docstring:
//
//   standard btn  physical   GamepadButtonId          libmanette code
//   ───────────── ────────── ──────────────────────── ───────────────
//   0             A          OK (1)                    304
//   1             B          CANCEL (2)                305
//   2             X          SECONDARY (3)             307
//   3             Y          OPTIONS (4)               308
//   4             LB         BUMPER_LEFT (9)           310
//   5             RB         BUMPER_RIGHT (10)         311
//   6             LT         TRIGGER_LEFT (7)          axis 10
//   7             RT         TRIGGER_RIGHT (8)         axis 9
//   8             Back/View  SELECT (6)                314
//   9             Start/Menu START (5)                 315
//   12/13/14/15   d-pad U/D/L/R  → direction()         hat 17/16
//   axes 0/1      left stick → direction() fallback    axis 0/1
//
// Triggers are analog buttons in the standard layout, so we threshold .value the
// same way the bridge thresholds the L2/R2 axis. Direction favours the vertical
// axis first, exactly like gamepad_bridge._emit_dir.

const { ipcRenderer } = require("electron");

// Which pads are PHYSICALLY attached, which navigator.getGamepads() refuses to
// say until one is pressed. The footer legend needs the answer on frame one, so
// src/shim/gamepad.ts calls this at startup. Returns null on platforms that
// can't answer — "unknown", never "no pad".
//
// The scan itself lives in the MAIN process (electron/native-pads.cjs) and is
// reached over IPC, because this preload is sandboxed: Electron has sandboxed
// renderers by default since v20, and a sandboxed preload's require() resolves
// only a few builtins like "electron". Requiring the scanner directly here threw
// and took the whole preload down with it — which silently killed the gamepad
// bridge below too, so the controller stopped working entirely. Keep every
// require in this file to "electron".
//
// sendSync (not invoke) because refreshFamily() in the renderer is synchronous
// and needs the answer during startup, not a frame or two later.
window.__rommNativePads = () => {
  try { return ipcRenderer.sendSync("romm:list-pads"); } catch { return null; }
};

// Desktop-only bridge the shared plugin UI feature-detects (window.__rommDesktop)
// to show an Exit row in the account menu — the Deck build has no such object.
window.__rommDesktop = {
  quit() { ipcRenderer.send("romm:quit"); },
  // Relaunch after the AppImage has been swapped by a self-update.
  restart() { ipcRenderer.send("romm:restart"); },
  // {exe, startDir, args} describing how to relaunch this shell — handed to the
  // backend so it can write a Steam shortcut pointing back at us. null when the
  // main process can't work it out.
  launchSpec() {
    try { return ipcRenderer.sendSync("romm:launch-spec"); } catch { return null; }
  },
  // The OS file chooser, for the shim's openFilePicker. Resolves to the chosen
  // absolute path, or null when the user cancelled. The shim falls back to its
  // own in-app picker when this is missing (the GTK shell has no IPC).
  pickFolder(opts) {
    return ipcRenderer.invoke("romm:pick-folder", opts || {});
  },
};

const OK = 1, CANCEL = 2, SECONDARY = 3, OPTIONS = 4;
const START = 5, SELECT = 6, TRIGGER_LEFT = 7, TRIGGER_RIGHT = 8;
const BUMPER_LEFT = 9, BUMPER_RIGHT = 10;

// standard-mapping button index → GamepadButtonId (d-pad handled separately).
const BUTTON_MAP = {
  0: OK, 1: CANCEL, 2: SECONDARY, 3: OPTIONS,
  4: BUMPER_LEFT, 5: BUMPER_RIGHT,
  6: TRIGGER_LEFT, 7: TRIGGER_RIGHT,
  8: SELECT, 9: START,
};

const DPAD = { up: 12, down: 13, left: 14, right: 15 };
const TRIGGER_ON = 0.3;    // analog trigger past this counts as pressed
const STICK_DEADZONE = 0.6; // matches gamepad_bridge STICK_DEADZONE

function pressed(btn) {
  if (!btn) return false;
  return typeof btn === "object"
    ? btn.pressed || btn.value > TRIGGER_ON
    : btn > TRIGGER_ON;
}

function startPolling() {
  // Input arrives from two places at once — Chromium's poll and the kernel
  // reader in the main process — and NEITHER is reliable on its own:
  //
  //   * Chromium reports a pad it cannot actually read. A pad switched on after
  //     launch shows up in getGamepads() (the gamepadconnected listener below
  //     arms that) while delivering no button state at all — measured, see
  //     native-input.cjs. The 8BitDo Ultimate goes further and enumerates TWO
  //     interfaces, at least one of which is permanently silent.
  //   * The kernel reader sees everything, but a multi-interface pad reports the
  //     same physical press on every one of its nodes.
  //
  // This used to be a winner-takes-all latch: the first frame Chromium admitted
  // to ANY pad, the kernel path was discarded for the rest of the session. That
  // is exactly backwards when the pad Chromium is holding is the silent one —
  // the controller worked for the split second before the first press, then went
  // dead for good, and a power-cycled pad never came back.
  //
  // So don't arbitrate: MERGE. Every source publishes its full current state and
  // the UI sees the union — a button is down if any source says it is, and the
  // direction is the first source with one. Duplicate nodes reporting the same
  // press collapse to a single press, a source that reports nothing contributes
  // nothing instead of masking the one that works, and a skew between two nodes
  // can no longer have one's release cancel the other's live press.
  const sources = new Map();  // source key → { buttons: Set<id>, dir: string|null }
  let sent = { buttons: new Set(), dir: null };  // what the UI last heard
  // Set while the window is in the background, so the first frame after focus
  // returns can re-sync silently instead of replaying held buttons as presses.
  let wasUnfocused = false;
  // Swallow the next flush, adopting its state as the baseline without
  // announcing it (see the wasUnfocused note in poll()).
  let adoptNext = false;

  function sourceFor(key) {
    let s = sources.get(key);
    if (!s) { s = { buttons: new Set(), dir: null }; sources.set(key, s); }
    return s;
  }

  // Union of every source, and the only thing the UI is told about.
  function flush() {
    const buttons = new Set();
    let dir = null;
    for (const s of sources.values()) {
      for (const id of s.buttons) buttons.add(id);
      if (dir === null) dir = s.dir;
    }
    if (adoptNext) { adoptNext = false; sent = { buttons, dir }; return; }
    const pad = window.__rommGamepad;
    if (pad) {
      // Presses first, then releases: a press and a release in the same flush is
      // a real tap, and the UI activates on the release.
      for (const id of buttons) if (!sent.buttons.has(id)) pad.button(id, true);
      for (const id of sent.buttons) if (!buttons.has(id)) pad.button(id, false);
      if (dir !== sent.dir) pad.direction(dir);
    }
    sent = { buttons, dir };
  }

  function releaseAll() {
    sources.clear();
    flush();
  }

  function poll() {
    // Don't drive the app while it's in the background — when a game launches,
    // RetroArch opens its own window and takes focus, but our renderer keeps
    // polling navigator.getGamepads() and would otherwise move the hidden UI
    // under the same stick/button presses meant for the game. Gate on real
    // window focus: release any held inputs and idle until the app is focused
    // again (alt-tab back, or the emulator exits).
    if (!document.hasFocus()) {
      releaseAll();
      wasUnfocused = true;
      requestAnimationFrame(poll);
      return;
    }

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    // Require the STANDARD mapping. Every index in BUTTON_MAP and DPAD is a
    // standard-layout index, so on a pad Chromium reports with any other mapping
    // they address the wrong controls — reading a garbage layout and publishing
    // it as fact is worse than not reading the pad at all. Those pads are left to
    // the kernel reader, which works from stable evdev codes.
    for (const p of pads) {
      if (p && p.connected && p.mapping === "standard") { gp = p; break; }
    }

    if (!gp) {
      // No pad the browser will admit to. Drop only OUR source: the kernel reader
      // may be driving a hot-plugged pad Chromium never surfaces (see
      // native-input.cjs), and its presses must survive.
      if (sources.delete("chromium")) flush();
      requestAnimationFrame(poll);
      return;
    }

    // First focused frame after a spell in the background: ADOPT whatever is
    // held without announcing it, so only genuinely new presses reach the UI.
    //
    // This is the mirror of releaseAll() above, and it is not symmetry for its
    // own sake. Quitting RetroArch from its menu is an A press; RetroArch exits
    // on the press, focus lands back on us while A is still physically down, and
    // the poll below would report it as a brand-new press. The UI activates on
    // the RELEASE that follows (see gamepad.ts) — which clicked the game tile
    // that still had focus and relaunched the game the user had just quit.
    if (wasUnfocused) {
      wasUnfocused = false;
      adoptNext = true;
    }

    // Face/shoulder/trigger/menu buttons.
    const s = sourceFor("chromium");
    s.buttons.clear();
    for (const [idx, id] of Object.entries(BUTTON_MAP)) {
      if (pressed(gp.buttons[idx])) s.buttons.add(id);
    }

    // Direction: d-pad buttons first, else the left stick past the deadzone.
    // Vertical wins over horizontal (mirrors gamepad_bridge._emit_dir).
    const axX = gp.axes[0] || 0, axY = gp.axes[1] || 0;
    const up = pressed(gp.buttons[DPAD.up]) || axY < -STICK_DEADZONE;
    const down = pressed(gp.buttons[DPAD.down]) || axY > STICK_DEADZONE;
    const left = pressed(gp.buttons[DPAD.left]) || axX < -STICK_DEADZONE;
    const right = pressed(gp.buttons[DPAD.right]) || axX > STICK_DEADZONE;
    s.dir = up ? "up" : down ? "down" : left ? "left" : right ? "right" : null;
    flush();

    requestAnimationFrame(poll);
  }

  // Kernel-read pad events from the main process (native-input.cjs), for the pads
  // Chromium won't surface here at all. They join the SAME emit path as the
  // browser poll, so held-button release, focus gating and de-duplication all
  // behave identically no matter which source produced the press.
  ipcRenderer.on("romm:native-pad", (_e, kind, payload) => {
    // A pad must not move the UI while a launched game holds focus.
    if (!document.hasFocus()) return;
    // One source PER DEVICE NODE, keyed by the evdev path. This is what makes a
    // multi-interface pad behave: the 8BitDo Ultimate reports each press on both
    // of its nodes, and merging them by union turns the duplicate into one press
    // instead of two events that can interleave into a self-cancelling mess.
    const s = sourceFor(payload.node || "native");
    if (kind === "button") {
      if (payload.down) s.buttons.add(payload.id); else s.buttons.delete(payload.id);
    } else if (kind === "direction") {
      s.dir = payload.dir;
    } else if (kind === "gone") {
      sources.delete(payload.node);
    }
    flush();
  });

  // Chromium only starts exposing a HOT-PLUGGED pad through getGamepads() once
  // the page has a gamepadconnected listener registered — polling alone sees
  // pads present at load, but not ones turned on later. Subscribing arms that
  // device monitoring; the handlers just reset our cached state so a reconnect
  // starts clean (the poll loop below does the actual reading every frame).
  window.addEventListener("gamepadconnected", () => { /* poll picks it up */ });
  window.addEventListener("gamepaddisconnected", releaseAll);

  requestAnimationFrame(poll);
}

// The app installs window.__rommGamepad inside startGamepad(); our poller guards
// each call, so we can begin polling as soon as the DOM is ready.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startPolling, { once: true });
} else {
  startPolling();
}
