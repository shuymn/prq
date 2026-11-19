// The component gallery (plan §1.17; `vite` in packages/server serves it at /gallery/gallery.html, `vite build --mode
// gallery` builds it into dist/gallery): every entry of the registry under its name, or with `?entry=<name>` that
// entry alone, at the page's origin, for a screenshot at its frame's size. The production build never includes it.
import "../styles/base.css";
import "virtual:prq/tokens.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "./gallery.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { REGISTRY } from "./registry.tsx";

function Gallery() {
  const only = new URLSearchParams(location.search).get("entry");
  if (only !== null) {
    const entry = REGISTRY.find((candidate) => candidate.name === only);
    return entry === undefined ? <p>No entry {only}</p> : entry.render();
  }
  return (
    <div className="gallery">
      {REGISTRY.map((entry) => (
        <section key={entry.name} className="entry">
          <h2>
            <a href={`?entry=${encodeURIComponent(entry.name)}`}>{entry.name}</a>
          </h2>
          <div className="specimen">{entry.render()}</div>
        </section>
      ))}
    </div>
  );
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("gallery.html has no #root");
}
createRoot(root).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
