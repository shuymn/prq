import "./AppHeader.css";
import type { ReactNode } from "react";

import { BrandMark } from "./BrandMark.tsx";
import { IconButtonLink } from "./IconButton.tsx";

// The page's header (design/components.md, AppHeader): the product's mark and name, the version of the build this
// tab runs, and at its end the pool's status and the link to the settings, marked on the Settings page.
export function AppHeader({
  version,
  pool,
  settings = false,
}: {
  version: string;
  pool?: ReactNode;
  settings?: boolean | undefined;
}) {
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
      <div className="end">
        {pool}
        <IconButtonLink icon="gear" label="Settings" href="/settings" current={settings} />
      </div>
    </header>
  );
}
