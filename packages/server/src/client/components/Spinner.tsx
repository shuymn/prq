import "./Spinner.css";

// An activity of unknown length (design/components.md, Foundations): an indeterminate <progress>, drawn as a ring with
// an arc. With a label it is announced as that progress; without one it is decoration next to text that says what
// is in progress (a busy button's label, a status).
export function Spinner({ label }: { label?: string }) {
  return label === undefined ? (
    <progress data-component="Spinner" aria-hidden="true" />
  ) : (
    <progress data-component="Spinner" aria-label={label} />
  );
}
