import "./Badge.css";

export type BadgeTone = "neutral" | "accent" | "success" | "attention" | "danger" | "done";

// A count or a short tag (design/components.md, Status and labels).
export function Badge({ tone, label }: { tone: BadgeTone; label: string }) {
  return (
    <span data-component="Badge" data-tone={tone}>
      {label}
    </span>
  );
}
