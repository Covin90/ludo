// Desktop button-hint bar — the equivalent of Steam's fixed bottom legend on
// the Deck. Steam renders that bar natively from each Focusable's
// on*ActionDescription / actionDescriptionMap props; our shim has no such chrome,
// so we rebuild it here. The gamepad layer (gamepad.ts) aggregates the current
// target's labels via computeLegend() and tells us when to refresh.
//
// Glyph art is Kenney's CC0 "Input Prompts" pack, inlined as SVG by glyphs.tsx
// (part of the bundle — nothing is fetched at runtime). Which set is drawn
// follows whoever is actually driving: the keyboard/mouse set in mouse mode, and
// the connected pad's own set (Xbox / PlayStation / Switch / neutral) once the
// pad takes over. See inputMode() for why that is not the same as "a pad is
// plugged in".
import { useEffect, useState } from "react";
import {
  computeLegend,
  currentLegendTarget,
  onLegendChange,
  onControllerFamilyChange,
  controllerFamily,
  padConnected,
  rememberedPadFamily,
  lastInputKind,
  type Legend,
} from "./gamepad";
import { Glyph, type GlyphSet } from "./glyphs";

// Semantic slot -> the physical button that slot maps to, per glyph set. The
// slots are the actions (ok/cancel/secondary/options); the values are what the
// user is actually looking at. Switch swaps A/B and X/Y against the standard
// layout, so its face buttons intentionally differ from the button index.
type Binding = { name: string; title: string };
const GAMEPAD_SLOTS: Record<Exclude<GlyphSet, "kbm">, Record<string, Binding>> = {
  neutral: {
    ok: { name: "a", title: "A" }, cancel: { name: "b", title: "B" },
    secondary: { name: "x", title: "X" }, options: { name: "y", title: "Y" },
    select: { name: "view", title: "View" }, start: { name: "menu", title: "Menu" },
    navigate: { name: "dpad", title: "D-pad" },
  },
  xbox: {
    ok: { name: "a", title: "A" }, cancel: { name: "b", title: "B" },
    secondary: { name: "x", title: "X" }, options: { name: "y", title: "Y" },
    select: { name: "view", title: "View" }, start: { name: "menu", title: "Menu" },
    navigate: { name: "dpad", title: "D-pad" },
  },
  ps: {
    ok: { name: "a", title: "Cross" }, cancel: { name: "b", title: "Circle" },
    secondary: { name: "x", title: "Square" }, options: { name: "y", title: "Triangle" },
    select: { name: "view", title: "Create" }, start: { name: "menu", title: "Options" },
    navigate: { name: "dpad", title: "D-pad" },
  },
  switch: {
    // Nintendo's physical A/B and X/Y sit mirrored, so the standard "bottom face
    // button = confirm" is the one printed B, and "right = cancel" is A.
    ok: { name: "b", title: "B" }, cancel: { name: "a", title: "A" },
    secondary: { name: "y", title: "Y" }, options: { name: "x", title: "X" },
    select: { name: "view", title: "Minus" }, start: { name: "menu", title: "Plus" },
    navigate: { name: "dpad", title: "D-pad" },
  },
};

// Keyboard/mouse bindings, matching what Focusable actually listens for in
// ui.tsx. Slots with no desktop equivalent (select/start are pad-only system
// buttons) are absent, and the legend simply omits them rather than showing a
// hint nothing can trigger.
const KBM_SLOTS: Record<string, Binding[]> = {
  navigate: [{ name: "arrows", title: "Arrow keys" }],
  ok: [{ name: "enter", title: "Enter" }],
  cancel: [{ name: "escape", title: "Escape" }],
  secondary: [{ name: "shift", title: "Shift" }, { name: "enter", title: "Enter" }],
  options: [{ name: "mouseRight", title: "Right click" }],
};

// One hint: the glyph(s) for a slot plus what the action does. Renders nothing
// when the active set has no binding for the slot (e.g. select/start on
// keyboard+mouse) — a label with no button attached would be noise.
function Hint({ set, slot, label }: { set: GlyphSet; slot: string; label?: string }) {
  if (!label) return null;
  const binds = set === "kbm" ? KBM_SLOTS[slot] : [GAMEPAD_SLOTS[set][slot]];
  if (!binds || binds.some((b) => !b)) return null;
  return (
    <span className="shim-legend-hint">
      {/* Multi-glyph slots are chords, e.g. Shift+Enter. */}
      <span className="shim-legend-chord">
        {binds.map((b, i) => (
          <Glyph key={i} set={set} name={b.name} title={b.title} />
        ))}
      </span>
      <span className="shim-legend-label">{label}</span>
    </span>
  );
}

// The legend follows whichever device the user last touched, in both directions:
// pick up the pad and it shows ABXY, reach for the keyboard and it shows
// Enter/Esc. Before anything has been touched it leans on the pad, because a
// launch with a controller attached should already be showing pad glyphs.
function pickSet(): GlyphSet {
  // Follow the device actually in use, so switching hands swaps the glyphs.
  if (lastInputKind() === "kbm") return "kbm";
  // Either the pad is driving, or nothing has been touched yet (null) — at
  // launch, with a pad attached, we want its glyphs up before the first press.
  if (padConnected()) return controllerFamily();
  // No pad visible and nothing touched yet. On Linux the sysfs scan already
  // settled this, so we only get here on platforms that can't enumerate: fall
  // back to the pad this user played with last session.
  if (lastInputKind() == null) {
    const remembered = rememberedPadFamily();
    if (remembered) return remembered;
  }
  return "kbm";
}

export function FooterLegend() {
  const [legend, setLegend] = useState<Legend>({});
  const [set, setSet] = useState<GlyphSet>(() => pickSet());

  useEffect(() => {
    let last = "";
    const recompute = () => {
      const l = computeLegend(currentLegendTarget());
      // Cheap identity check so we don't re-render on every mouse micro-move.
      const key = JSON.stringify(l);
      if (key !== last) { last = key; setLegend(l); }
    };
    const resync = () => setSet(pickSet());
    recompute();
    resync();
    const offL = onLegendChange(recompute);
    const offF = onControllerFamilyChange(resync);
    // Safety net: labels can change on the SAME focused element (e.g. a two-step
    // delete confirm) without any focus/hover event to trigger recompute.
    const iv = window.setInterval(recompute, 500);
    return () => { offL(); offF(); window.clearInterval(iv); };
  }, []);

  // Left cluster: system buttons. Right cluster: face-button actions.
  return (
    <div className="shim-legend">
      <div className="shim-legend-group">
        <Hint set={set} slot="navigate" label="Navigate" />
        <Hint set={set} slot="select" label={legend.select} />
        <Hint set={set} slot="start" label={legend.start} />
      </div>
      <div className="shim-legend-group">
        <Hint set={set} slot="ok" label={legend.ok} />
        <Hint set={set} slot="secondary" label={legend.secondary} />
        <Hint set={set} slot="options" label={legend.options} />
        <Hint set={set} slot="cancel" label={legend.cancel} />
      </div>
    </div>
  );
}
