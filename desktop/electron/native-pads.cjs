// Which gamepads are attached, asked of the OS instead of the browser.
//
// Chromium deliberately hides gamepads from navigator.getGamepads() until the
// user presses a button on one (anti-fingerprinting). That's fine for INPUT —
// you can't act on a pad before touching it — but it's useless for the button-
// hint legend, which has to be correct on the very first frame, before any
// press. The renderer has no way to ask "is a pad attached", so we ask Linux.
//
// Read-only sysfs, no native module, no udev dependency: /sys/class/input holds
// one inputN directory per device with its name and USB vendor/product IDs. We
// return them in the same shape as a Gamepad.id string so the renderer can reuse
// its existing family detection unchanged.
//
// LINUX ONLY. Windows has no comparable dependency-free enumeration (it would
// need XInput/HID via a native addon or a slow PowerShell spawn), so there we
// return null — meaning "unknown", NOT "no pad" — and the renderer keeps using
// its remembered-pad guess. The distinction matters: null must never be read as
// a negative answer.

const fs = require("fs");
const path = require("path");

const INPUT_CLASS = "/sys/class/input";

// BTN_SOUTH / BTN_GAMEPAD — the A button. Its presence in a device's key
// capability bitmask is how udev and SDL classify something as a gamepad.
const BTN_SOUTH = 0x130;

// capabilities/key is a space-separated list of 64-bit hex words printed
// most-significant-word FIRST, so the last word holds bits 0-63.
function hasKeyBit(capsKey, bit) {
  const words = capsKey.trim().split(/\s+/);
  const wordIndex = Math.floor(bit / 64);
  const w = words[words.length - 1 - wordIndex];
  if (!w) return false;
  return (BigInt("0x" + w) >> BigInt(bit % 64)) & 1n ? true : false;
}

function read(...p) {
  try { return fs.readFileSync(path.join(...p), "utf8").trim(); }
  catch { return null; }
}

// A device counts as a pad only if it advertises BTN_SOUTH.
//
// Do NOT use "has a jsN node" as the test, however tempting: joydev creates one
// for anything with axes plus buttons, so virtual pointer devices get js nodes
// too. A "Mouse passthrough (absolute)" on the dev machine owned js0 and so
// outranked the real Xbox pad on js1 — picking the wrong "first" pad, which is
// exactly the bug this file exists to fix. Its key bits are in the BTN_LEFT
// mouse range; only real gamepads claim BTN_SOUTH.
function isGamepad(dir) {
  const caps = read(dir, "capabilities", "key");
  return caps ? hasKeyBit(caps, BTN_SOUTH) : false;
}

// Returns an array of Gamepad.id-style strings, or null when this platform can't
// answer. Ordered by input index, so [0] is the first-attached pad.
function listNativePads() {
  if (process.platform !== "linux") return null;

  let entries;
  try { entries = fs.readdirSync(INPUT_CLASS); }
  catch { return null; } // no sysfs (container?) — unknown, not empty
  const pads = [];

  for (const e of entries.filter((x) => /^input\d+$/.test(x))
                         .sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)))) {
    const dir = path.join(INPUT_CLASS, e);
    if (!isGamepad(dir)) continue;
    const name = read(dir, "name") || "Gamepad";
    const vendor = read(dir, "id", "vendor") || "0000";
    const product = read(dir, "id", "product") || "0000";
    // Match Chromium's Gamepad.id shape so detectFamily() in the renderer parses
    // native and browser-reported pads with one code path.
    pads.push(`${name} (Vendor: ${vendor} Product: ${product})`);
  }
  return pads;
}

module.exports = { listNativePads };
