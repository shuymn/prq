// What the build defines (packages/server/vite.config.ts); Vite's own types (tsconfig.client.json) cover the
// stylesheets, `virtual:prq/tokens.css` among them.

// The version this build shows next to the product name, `v` + packages/server/package.json `version`.
declare const __PRQ_VERSION__: string;

// HTML attributes Chrome implements that React's types do not list yet; React passes them to the DOM as they are.
declare namespace React {
  interface ButtonHTMLAttributes<T> {
    // Invoker commands: the button acts on the element of that ID (a popover it toggles).
    commandfor?: string | undefined;
    command?: "toggle-popover" | "show-popover" | "hide-popover" | `--${string}` | undefined;
  }
  interface HTMLAttributes<T> {
    // Arrow-key focus navigation among the element's items (`menu nomemory` for a menu).
    focusgroup?: string;
  }
}
