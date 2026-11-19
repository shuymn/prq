import "./SegmentedControl.css";
import { useId } from "react";

// One of two choices (design/components.md, Controls): native radio buttons, so the group is one Tab stop and the
// arrow keys move the choice. `selected` names the chosen segment.
export function SegmentedControl({
  label,
  first,
  second,
  selected,
  onSelect,
}: {
  label: string;
  first: string;
  second: string;
  selected: "first" | "second";
  onSelect?: ((segment: "first" | "second") => void) | undefined;
}) {
  const name = useId();
  return (
    <div data-component="SegmentedControl" data-selected={selected} role="radiogroup" aria-label={label}>
      {(["first", "second"] as const).map((segment) => (
        <label key={segment} className="segment">
          <input type="radio" name={name} checked={selected === segment} onChange={() => onSelect?.(segment)} />
          {segment === "first" ? first : second}
        </label>
      ))}
    </div>
  );
}
