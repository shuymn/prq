import "./Sha.css";

// A commit by its first seven digits (design/components.md, Status and labels); the full SHA is its accessible name.
export function Sha({ sha }: { sha: string }) {
  return (
    <code data-component="Sha" aria-label={sha}>
      {sha.slice(0, 7)}
    </code>
  );
}
