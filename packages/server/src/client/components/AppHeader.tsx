import "./AppHeader.css";
import { BrandMark } from "./BrandMark.tsx";

// The page's header (design/components.md, AppHeader): the product's mark and name, and the version of the build this
// tab runs.
export function AppHeader({ version }: { version: string }) {
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
    </header>
  );
}
