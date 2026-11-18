// What the build adds for Workers Static Assets (docs/design.md, Caching): the `_headers` rules for the files it
// emitted, and the preload of the one font the first paint needs.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Plugin } from "vite";

// The platform's limits on `_headers`: rules (a path line and its headers) and the length of a line.
export const HEADER_RULES_MAX = 100;
const HEADER_LINE_MAX = 2000;

const IMMUTABLE = "public, max-age=31536000, immutable";

// The rules of a `_headers` file: its lines that start a path, comments and blank lines aside.
function ruleCount(headers: string): number {
  return headers.split("\n").filter((line) => line !== "" && !line.startsWith("#") && !/^\s/.test(line)).length;
}

// The `_headers` text: the base rules (public/_headers: the rules for every path, the shell's `no-cache`, CSP and the
// rest), then one rule per emitted file under the assets directory, which replaces `no-cache` with a year's immutable
// caching. A file the build did not emit has no rule of its own, so the single-page fallback answers it with the shell
// under `no-cache`, and nothing caches that answer for a year. Throws past the platform's limits rather than produce
// rules the platform would drop.
export function headersText(base: string, assetsDir: string, files: string[]): string {
  const emitted = files.filter((name) => name.startsWith(`${assetsDir}/`)).toSorted();
  const rules = emitted.map((name) => `/${name}\n  ! Cache-Control\n  Cache-Control: ${IMMUTABLE}\n`);
  const source = `${base.trimEnd()}\n${rules.join("")}`;
  const count = ruleCount(source);
  if (count > HEADER_RULES_MAX) {
    throw new Error(`_headers would hold ${count} rules; Workers Static Assets applies at most ${HEADER_RULES_MAX}`);
  }
  const long = source.split("\n").find((line) => line.length > HEADER_LINE_MAX);
  if (long !== undefined) {
    throw new Error(`a _headers line is longer than ${HEADER_LINE_MAX} characters: ${long.slice(0, 80)}…`);
  }
  return source;
}

// Emits `_headers` for the files the build emitted (headersText); the build fails where headersText throws.
export function headersPlugin(): Plugin {
  let publicDir = "";
  let assetsDir = "";
  return {
    name: "prq:headers",
    apply: "build",
    configResolved(config) {
      publicDir = config.publicDir;
      assetsDir = config.build.assetsDir;
    },
    async generateBundle(_options, bundle) {
      const base = await readFile(join(publicDir, "_headers"), "utf8");
      const files = Object.values(bundle).map((file) => file.fileName);
      this.emitFile({ type: "asset", fileName: "_headers", source: headersText(base, assetsDir, files) });
    },
  };
}

// Preloads the font file the first paint uses (Inter 400, Latin), under the name the build gave it. The build fails
// when the file is missing, so a renamed font cannot drop the preload unnoticed.
export function fontPreloadPlugin(original: string): Plugin {
  return {
    name: "prq:font-preload",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        const font = Object.values(context.bundle ?? {}).find(
          (file) => file.type === "asset" && file.originalFileNames.some((name) => name.endsWith(original)),
        );
        if (font === undefined) {
          throw new Error(`the build emitted no ${original} to preload`);
        }
        return [
          {
            tag: "link",
            attrs: { rel: "preload", href: `/${font.fileName}`, as: "font", type: "font/woff2", crossorigin: "" },
            injectTo: "head",
          },
        ];
      },
    },
  };
}
