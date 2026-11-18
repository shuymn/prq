// The BrandMark's paths, as the Pencil components BrandMark/brand and BrandMark/face draw them on their 16px grid
// (design/components.md, Brand): the stepped tile and the face, whose eyes are holes. The React component and the
// favicon script (packages/server/build/icons.ts) both draw from these.

export const GRID = 16;

export const TILE_PATH = "M2 0h12v1h1v1h1v12h-1v1h-1v1h-12v-1h-1v-1h-1v-12h1v-1h1z";

export const FACE_PATH = "M2 4h5v4h-3v4h-2z m2 1v2h2v-2z m5-1h5v8h-2v-4h-3z m1 1v2h2v-2z m-4 4h4v2h-1v-1h-1v2h-2z";

// The face alone occupies 12 × 8 cells of the grid, from column 2 and row 4.
export const FACE_BOX = { x: 2, y: 4, width: 12, height: 8 } as const;
