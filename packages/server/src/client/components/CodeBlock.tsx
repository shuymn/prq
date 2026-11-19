import "./CodeBlock.css";
import { useEffect, useRef, useState } from "react";

import { IconButton } from "./IconButton.tsx";

// How long the copy's outcome stays shown.
const FEEDBACK_MS = 2000;

// A fenced code block of a summary or an answer (design/components.md, PR detail): its text in the code font, in one
// color (no highlighting in #7), and a button that copies the text. The outcome shows next to the button in a status
// bubble, which is also what a screen reader announces; it clears after a moment.
export function CodeBlock({ code, language }: { code: string; language?: string | undefined }) {
  const [outcome, setOutcome] = useState<"Copied" | "Copy failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const report = (text: "Copied" | "Copy failed") => {
    clearTimeout(timer.current);
    setOutcome(text);
    timer.current = setTimeout(() => setOutcome(null), FEEDBACK_MS);
  };
  const copy = () => {
    navigator.clipboard.writeText(code).then(
      () => report("Copied"),
      () => report("Copy failed"),
    );
  };

  return (
    <div data-component="CodeBlock" data-language={language}>
      <pre>
        <code>{code}</code>
      </pre>
      <span className="copy">
        <IconButton
          variant="secondary"
          size="sm"
          icon={outcome === "Copied" ? "check" : "copy"}
          label="Copy code"
          onClick={copy}
        />
        <span className="tip" role="status" data-shown={outcome !== null}>
          {outcome}
        </span>
      </span>
    </div>
  );
}
