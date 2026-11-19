// The design tokens script needs as values (design/tokens.json; CSS reads the custom properties).

import { breakpoint } from "../../../../design/tokens.json";

// Below this width the UI takes the extension panel's layout (a custom property cannot appear in a media query).
export const NARROW_PX = breakpoint.narrow.$value.value;
