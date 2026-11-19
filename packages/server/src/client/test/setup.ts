// Every client test runs with the page's stylesheets: the cascade layers, the design tokens and the fonts, as
// main.tsx loads them, and with no list filter left in storage by an earlier test.
import "../styles/base.css";
import "virtual:prq/tokens.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import { beforeEach } from "vitest";

beforeEach(() => {
  localStorage.clear();
});
