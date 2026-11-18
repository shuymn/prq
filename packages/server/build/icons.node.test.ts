import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { FACE_PATH, GRID, TILE_PATH } from "../src/client/brand.ts";
import { brandColors, faviconSvg } from "./icons.ts";
import { decodePng, pixel } from "./png.ts";

const PUBLIC_DIR = new URL("../src/client/public/", import.meta.url);
const read = (name: string) => readFile(new URL(name, PUBLIC_DIR));

// The cells of the 16px grid a path fills (SVG's nonzero rule), from its h, v, m, M and z commands: each cell's centre
// is inside when the path's vertical edges to its right wind around it.
function cells(path: string): Set<string> {
  const edges: { x: number; from: number; to: number }[] = [];
  let [x, y, startX, startY] = [0, 0, 0, 0];
  for (const [, command = "", argument = ""] of path.matchAll(/([MmHhVvZz])([^MmHhVvZz]*)/g)) {
    const numbers = (argument.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (command === "M" || command === "m") {
      [x, y] = command === "M" ? [numbers[0] ?? 0, numbers[1] ?? 0] : [x + (numbers[0] ?? 0), y + (numbers[1] ?? 0)];
      [startX, startY] = [x, y];
    } else if (command === "h") {
      x += numbers[0] ?? 0;
    } else if (command === "v") {
      edges.push({ x, from: y, to: y + (numbers[0] ?? 0) });
      y += numbers[0] ?? 0;
    } else if (command === "z" || command === "Z") {
      if (x === startX && y !== startY) {
        edges.push({ x, from: y, to: startY });
      }
      [x, y] = [startX, startY];
    } else {
      throw new Error(`unexpected command ${command}`);
    }
  }
  const filled = new Set<string>();
  for (let row = 0; row < GRID; row += 1) {
    for (let column = 0; column < GRID; column += 1) {
      const [px, py] = [column + 0.5, row + 0.5];
      const winding = edges
        .filter((edge) => edge.x > px && Math.min(edge.from, edge.to) < py && py < Math.max(edge.from, edge.to))
        .reduce((sum, edge) => sum + Math.sign(edge.to - edge.from), 0);
      if (winding !== 0) {
        filled.add(`${column},${row}`);
      }
    }
  }
  return filled;
}

const FACE = cells(FACE_PATH);
const TILE = cells(TILE_PATH);

// The color a grid cell shows: the face over the tile, else transparent.
function cellColor(column: number, row: number, colors: { tile: string; face: string }): string {
  const key = `${column},${row}`;
  if (FACE.has(key)) {
    return `${colors.face}ff`;
  }
  return TILE.has(key) ? `${colors.tile}ff` : "#00000000";
}

describe("the favicon set", () => {
  test("favicon.svg is the brand mark in the token colors", async () => {
    const colors = await brandColors();
    expect(colors).toEqual({ tile: "#1f6feb", face: "#ffffff" });
    expect(await read("favicon.svg").then(String)).toBe(faviconSvg(colors));
  });

  test("favicon-32.png is the mark's grid at 2×, each cell two pixels square", async () => {
    const colors = await brandColors();
    const image = decodePng(await read("favicon-32.png"));
    expect([image.width, image.height]).toEqual([32, 32]);
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        expect(pixel(image, x, y), `pixel ${x},${y}`).toBe(cellColor(x >> 1, y >> 1, colors));
      }
    }
  });

  test("apple-touch-icon.png is the grid at 11×, centred on a 180px canvas of the tile color", async () => {
    const colors = await brandColors();
    const image = decodePng(await read("apple-touch-icon.png"));
    expect([image.width, image.height]).toEqual([180, 180]);
    for (let y = 0; y < 180; y += 1) {
      for (let x = 0; x < 180; x += 1) {
        const inside = x >= 2 && x < 178 && y >= 2 && y < 178;
        const color = inside ? cellColor(Math.floor((x - 2) / 11), Math.floor((y - 2) / 11), colors) : "#00000000";
        expect(pixel(image, x, y), `pixel ${x},${y}`).toBe(color === "#00000000" ? `${colors.tile}ff` : color);
      }
    }
  });
});
