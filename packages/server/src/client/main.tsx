// zod's setting comes before any module that holds a schema (zod.ts). The layers come next (styles/base.css declares
// their order), then the tokens and the self-hosted fonts: Inter (400, 600) and JetBrains Mono (400), Latin, which the
// font tokens name.
import "./zod.ts";
import "./styles/base.css";
import "virtual:prq/tokens.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html has no #root");
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
