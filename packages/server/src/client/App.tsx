import { AppHeader } from "./components/AppHeader.tsx";

// The page on every path: the header, and the content the routes will fill.
export function App() {
  return (
    <>
      <AppHeader version={__PRQ_VERSION__} />
      <main />
    </>
  );
}
