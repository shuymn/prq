// The web UI's stylesheets take colors, sizes, fonts, shadows and motion from the design tokens only (design/README.md):
// a raw value is refused (`pnpm run lint:css`, CI's Check job and the pre-commit hook). Only stylelint's built-in rules;
// packages/server/build/style-check.node.test.ts runs this configuration on fixtures that pass and fail.

// A single design token, the only value most properties below may take besides a keyword.
const TOKEN = /^var\(--[a-z0-9-]+\)$/;
// One to four tokens, as a multi-value color property takes them (a spinner's `border-color`).
const TOKENS = /^var\(--[a-z0-9-]+\)( var\(--[a-z0-9-]+\)){0,3}$/;

const BLOCK_SIZES = ["block-size", "min-block-size", "max-block-size", "height", "min-height", "max-height"];
const INLINE_SIZES = ["inline-size", "min-inline-size", "max-inline-size", "width", "min-width", "max-width"];

// A property name as a pattern that matches it in any case: CSS property names are case-insensitive, and an exact
// string would let `WIDTH` or `FONT-FAMILY` pass.
const property = (name) => `/^${name}$/i`;

// The values a size may take: a token, or one of a few intrinsic values (a line count for block sizes, the measure for
// running text).
const sizes = (names, values) => Object.fromEntries(names.map((name) => [property(name), [TOKEN, ...values]]));

// Properties that take a color: a token, or a keyword that names no color of its own (system colors such as
// `CanvasText` included, which `color-named` does not know).
const COLORS =
  "/^(color|background(-color)?|fill|stroke|caret-color|accent-color|outline-color|text-decoration-color|" +
  "border(-(top|right|bottom|left|block|inline)(-(start|end))?)?-color)$/i";

const VALUES = {
  ...sizes(BLOCK_SIZES, ["auto", "0", "100%", "1lh", "3lh", "10lh"]),
  ...sizes(INLINE_SIZES, ["auto", "0", "100%", "none"]),
  [property("max-inline-size")]: [TOKEN, "auto", "0", "100%", "none", "80ch"],
  [COLORS]: [TOKENS, "inherit", /^currentcolor$/i, "transparent", "none"],
  // A border or outline shorthand: tokens and line-style keywords only, so its color is a token too.
  "/^(border(-(top|right|bottom|left|block|inline)(-(start|end))?)?|outline)$/i": [
    /^(var\(--[a-z0-9-]+\)|none|0|solid|dashed|dotted|currentcolor|transparent)( (var\(--[a-z0-9-]+\)|solid|dashed|dotted|currentcolor|transparent))*$/i,
    "inherit",
  ],
  // Every font property is a token (the `font` shorthand takes a text style), but for the fallback fonts' adjustment
  // and an upright or italic style.
  "/^font/i": [TOKEN, "inherit"],
  [property("font-size-adjust")]: ["from-font"],
  [property("font-style")]: ["normal", "italic", "inherit"],
  [property("line-height")]: [TOKEN, "inherit"],
  [property("letter-spacing")]: [TOKEN, "inherit"],
  [property("box-shadow")]: ["none", /^var\(--shadow-[a-z0-9-]+\)$/],
  [property("opacity")]: ["0", "1"],
  [property("z-index")]: ["0", "1", "2", "3"],
  // A custom property the stylesheets declare refers to a token: the built-in rules above see units, hex colors and
  // color functions in its value, but not a named color, a font name or a bare number.
  "/^--/": [TOKEN],
};

// No unit but `fr`, outside a few properties: percentages for sizes, line counts for block sizes, the measure, and
// degrees for a rotation (the spinner).
const UNITS = [
  ["fr"],
  {
    ignoreProperties: {
      "%": [...BLOCK_SIZES, ...INLINE_SIZES],
      lh: BLOCK_SIZES,
      ch: ["max-inline-size"],
      deg: [property("rotate")],
    },
  },
];

export default {
  rules: {
    "color-no-hex": true,
    "color-named": "never",
    "function-disallowed-list": [
      "rgb",
      "rgba",
      "hsl",
      "hsla",
      "hwb",
      "lab",
      "lch",
      "oklab",
      "oklch",
      "color",
      "color-mix",
      "light-dark",
      "cubic-bezier",
      "steps",
      "linear",
    ],
    "unit-allowed-list": UNITS,
    "declaration-property-value-allowed-list": VALUES,
  },
  overrides: [
    {
      // The AppHeader's mark sits on whole pixels: "prq" is lowercase only, so the mark moves 1px down to centre on its
      // x-height (design/components.md, AppHeader). That offset, and only that value, is the one raw length.
      files: ["packages/server/src/client/components/AppHeader.css"],
      rules: {
        "unit-allowed-list": [UNITS[0], { ignoreProperties: { ...UNITS[1].ignoreProperties, px: ["translate"] } }],
        "declaration-property-value-allowed-list": { ...VALUES, [property("translate")]: ["0 1px"] },
      },
    },
  ],
};
