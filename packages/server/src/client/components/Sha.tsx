import "./Sha.css";

// A commit's first seven digits, as Sha shows them and text names the commit.
export const shortSha = (sha: string) => sha.slice(0, 7);

// A commit by its first seven digits (design/components.md, Status and labels); the full SHA is its accessible name.
export function Sha({ sha }: { sha: string }) {
  return (
    <code data-component="Sha" aria-label={sha}>
      {shortSha(sha)}
    </code>
  );
}
