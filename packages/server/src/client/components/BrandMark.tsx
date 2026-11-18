import "./BrandMark.css";
import { FACE_BOX, FACE_PATH, GRID, TILE_PATH } from "../brand.ts";

// The product's pixel mark (design/components.md, Brand). `brand` is the face on its stepped tile (the favicon's
// drawing); `face` is the face alone, the mark before the product name. Pixel art stays crisp only at whole multiples
// of its grid, so `size` is that multiple: brand is 16 × size, face 12 × size by 8 × size. Its colors are the tokens'
// (BrandMark.css). It is decorative: the product name next to it says what it is.
export function BrandMark({ variant, size }: { variant: "brand" | "face"; size: 1 | 2 | 3 | 4 }) {
  const box = variant === "brand" ? { x: 0, y: 0, width: GRID, height: GRID } : FACE_BOX;
  return (
    <svg
      data-component="BrandMark"
      data-variant={variant}
      data-size={size}
      width={box.width * size}
      height={box.height * size}
      viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {variant === "brand" && <path className="tile" d={TILE_PATH} />}
      <path className="face" d={FACE_PATH} />
    </svg>
  );
}
