// `pnpm run icons`: writes the favicon set into src/client/public from the BrandMark's `brand` drawing
// (src/client/brand.ts) in the token colors: favicon.svg, and favicon-32.png and apple-touch-icon.png rendered from it
// in the machine's Chrome. The three are committed; run this again after the mark or its colors change
// (design/components.md, Brand).

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { FACE_PATH, GRID, TILE_PATH } from "../src/client/brand.ts";
import { tokenValues } from "./tokens.ts";

const PUBLIC_DIR = fileURLToPath(new URL("../src/client/public/", import.meta.url));
// How long Chrome has to start, and each page step to complete.
const CHROME_MS = 30_000;

// The apple-touch icon: the grid at 11× (176px), centred on a 180px canvas of the tile's color, since iOS rounds the
// corners itself.
const TOUCH_SIZE = 180;
const TOUCH_SCALE = 11;

export async function brandColors(): Promise<{ tile: string; face: string }> {
  const values = await tokenValues();
  const tile = values.get("color.accent.emphasis");
  const face = values.get("color.fg.on-emphasis");
  if (tile === undefined || face === undefined) {
    throw new Error("design/tokens.json has no color.accent.emphasis or color.fg.on-emphasis");
  }
  return { tile, face };
}

export function faviconSvg({ tile, face }: { tile: string; face: string }): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" shape-rendering="crispEdges">`,
    `<path fill="${tile}" d="${TILE_PATH}"/>`,
    `<path fill="${face}" d="${FACE_PATH}"/>`,
    "</svg>\n",
  ].join("");
}

// A page of the given size, transparent unless the canvas has a color, with the mark at size px centred on it.
function canvas(svg: string, page: number, size: number, background: string | null): string {
  const sized = svg.replace("<svg ", `<svg width="${size}" height="${size}" `);
  const fill = background === null ? "transparent" : background;
  return `<!doctype html><html><body style="margin:0;background:${fill}"><div style="width:${page}px;height:${page}px;display:grid;place-items:center">${sized}</div></body></html>`;
}

async function main(): Promise<void> {
  const colors = await brandColors();
  const svg = faviconSvg(colors);
  await writeFile(`${PUBLIC_DIR}favicon.svg`, svg);
  const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: CHROME_MS });
  try {
    const render = async (page: number, size: number, background: string | null): Promise<Buffer> => {
      const tab = await browser.newPage({ viewport: { width: page, height: page }, deviceScaleFactor: 1 });
      tab.setDefaultTimeout(CHROME_MS);
      await tab.setContent(canvas(svg, page, size, background));
      const png = await tab.screenshot({ omitBackground: background === null, type: "png" });
      await tab.close();
      return png;
    };
    await writeFile(`${PUBLIC_DIR}favicon-32.png`, await render(32, 32, null));
    await writeFile(`${PUBLIC_DIR}apple-touch-icon.png`, await render(TOUCH_SIZE, GRID * TOUCH_SCALE, colors.tile));
  } finally {
    await browser.close();
  }
  process.stdout.write(`wrote favicon.svg, favicon-32.png and apple-touch-icon.png in ${PUBLIC_DIR}\n`);
}

if (import.meta.main) {
  await main();
}
