import "./AppHeader.css";
import type { ReactNode } from "react";

import { BrandMark } from "./BrandMark.tsx";

// The page's header (design/components.md, AppHeader): the product's mark and name, the version of the build this
// tab runs, and at its end the pool's status.
export function AppHeader({ version, pool }: { version: string; pool?: ReactNode }) {
  return (
    <header data-component="AppHeader">
      <div className="start">
        <span className="mark-box">
          <BrandMark variant="face" size={2} />
        </span>
        <span className="name">
          <span className="product">prq</span>
          <span className="version">{version}</span>
        </span>
      </div>
      {pool !== undefined && <div className="end">{pool}</div>}
    </header>
  );
}
