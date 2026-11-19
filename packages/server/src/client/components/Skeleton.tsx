import "./Skeleton.css";

// A placeholder for content that is loading (design/components.md, Feedback). It has no size of its own: the screen
// sizes it to the content it stands in for. Hidden from assistive technology; the region that loads says it is busy.
export function Skeleton({ shape }: { shape: "line" | "block" }) {
  return <span data-component="Skeleton" data-shape={shape} aria-hidden="true" />;
}
