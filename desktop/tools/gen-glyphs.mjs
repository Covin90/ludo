// Regenerates src/shim/glyphs.tsx from a Kenney "Input Prompts" download.
//
//   node tools/gen-glyphs.mjs ~/Downloads/kenney_input-prompts_1.5
//
// The generated file is committed, so this only needs re-running when the glyph
// inventory changes or Kenney ships a new pack version. We inline the SVG source
// rather than shipping files so the glyphs are part of the bundle: no extra HTTP
// round-trips to the backend for 34 tiny assets, nothing to go missing in a
// packaged build, and they stay sharp under the shell's zoom-to-fit because they
// scale as vectors with the page.
//
// Kenney's Input Prompts is CC0 — commercial use is fine and attribution is not
// required (we credit anyway, see the header written into glyphs.tsx).

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const PACK = process.argv[2];
if (!PACK) {
  console.error("usage: node tools/gen-glyphs.mjs <path-to-kenney-input-prompts>");
  process.exit(1);
}

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../src/shim/glyphs.tsx");

// glyph name -> "<pack subdir>/Vector/<file>.svg"
//
// The face-button sets deliberately use each platform's own art, so the letter/
// shape a user sees in the legend is the one printed on the pad in their hands.
// `neutral` borrows the Steam Deck set: it's the only one with plain grey,
// letter-labelled ABXY in the standard layout (Kenney's "Generic" pack has no
// lettered face buttons at all).
const SETS = {
  xbox: {
    dir: "Xbox Series",
    files: {
      a: "xbox_button_color_a", b: "xbox_button_color_b",
      x: "xbox_button_color_x", y: "xbox_button_color_y",
      view: "xbox_button_view", menu: "xbox_button_menu",
      dpad: "xbox_dpad_all",
    },
  },
  ps: {
    dir: "PlayStation Series",
    files: {
      a: "playstation_button_color_cross", b: "playstation_button_color_circle",
      x: "playstation_button_color_square", y: "playstation_button_color_triangle",
      view: "playstation5_button_create", menu: "playstation5_button_options",
      dpad: "playstation_dpad_all",
    },
  },
  switch: {
    dir: "Nintendo Switch",
    files: {
      a: "switch_button_a", b: "switch_button_b",
      x: "switch_button_x", y: "switch_button_y",
      view: "switch_button_minus", menu: "switch_button_plus",
      dpad: "switch_dpad_all",
    },
  },
  neutral: {
    dir: "Steam Deck",
    files: {
      a: "steamdeck_button_a", b: "steamdeck_button_b",
      x: "steamdeck_button_x", y: "steamdeck_button_y",
      view: "steamdeck_button_view", menu: "steamdeck_button_options",
      dpad: "steamdeck_dpad_all",
    },
  },
  kbm: {
    dir: "Keyboard & Mouse",
    files: {
      arrows: "keyboard_arrows_all",
      enter: "keyboard_enter",
      escape: "keyboard_escape",
      shift: "keyboard_shift",
      mouseLeft: "mouse_left",
      mouseRight: "mouse_right",
    },
  },
};

// Kenney's SVGs are 64x64 with a <defs/> stub and pretty-printed whitespace.
// Strip what we don't need and drop the width/height so CSS sizes them.
function minify(svg) {
  return svg
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<defs\s*\/>/g, "")
    .replace(/\s+xmlns:xlink="[^"]*"/g, "")
    .replace(/\swidth="64"\sheight="64"/, ' viewBox="0 0 64 64"')
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const parts = [];
for (const [set, { dir, files }] of Object.entries(SETS)) {
  const entries = Object.entries(files).map(([name, file]) => {
    const src = readFileSync(resolve(PACK, dir, "Vector", `${file}.svg`), "utf8");
    return `    ${name}: ${JSON.stringify(minify(src))},`;
  });
  parts.push(`  ${set}: {\n${entries.join("\n")}\n  },`);
}

const out = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node tools/gen-glyphs.mjs <path-to-kenney-input-prompts>
//
// Controller/keyboard button art from Kenney's "Input Prompts" pack
// (https://kenney.nl/assets/input-prompts), released under CC0. Attribution is
// not required by the licence; we credit Kenney because the work deserves it.
//
// Each entry is raw SVG markup, injected with dangerouslySetInnerHTML by
// <Glyph> below. Inlined rather than <img src> so they ship inside the bundle
// and scale as vectors under the shell's zoom-to-fit. The markup is build-time
// input from a fixed local pack, never user or network data, so
// dangerouslySetInnerHTML carries no injection risk here.

export type GlyphSet = "xbox" | "ps" | "switch" | "neutral" | "kbm";

export const GLYPHS: Record<GlyphSet, Record<string, string>> = {
${parts.join("\n")}
};

// Renders one glyph. \`title\` is the accessible name — the legend's visible text
// says what the button DOES, so the glyph itself names the button.
export function Glyph({ set, name, title }: { set: GlyphSet; name: string; title: string }) {
  const svg = GLYPHS[set][name];
  if (!svg) return null;
  return (
    <span
      className="shim-glyph"
      role="img"
      aria-label={title}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out);
console.log(`wrote ${OUT} (${(out.length / 1024).toFixed(1)} kB)`);
