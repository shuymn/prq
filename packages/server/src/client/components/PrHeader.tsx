import "./PrHeader.css";
import { ButtonLink } from "./Button.tsx";
import { IconButtonLink } from "./IconButton.tsx";
import { type PrState, PrStateLabel } from "./PrStateLabel.tsx";

// The pull request a detail page is about (design/components.md, PR detail): its state, repository and number, its
// title as the page's heading, and a link to it on GitHub. Compact is the panel's: a smaller title and an icon link.
export function PrHeader({
  density,
  state,
  repository,
  number,
  title,
  url,
}: {
  density: "full" | "compact";
  // Null until the pull request's first webhook.
  state: PrState | null;
  repository: string;
  number: number;
  title: string;
  url: string;
}) {
  return (
    <header data-component="PrHeader" data-density={density}>
      <div className="heading">
        <p className="meta">
          {state !== null && <PrStateLabel state={state} />}
          <span className="repository">
            {repository} #{number}
          </span>
        </p>
        <h1 className="title" tabIndex={-1}>
          {title}
        </h1>
      </div>
      {density === "full" ? (
        <ButtonLink variant="secondary" size="md" label="Open on GitHub" href={url} external />
      ) : (
        <IconButtonLink icon="link-external" label="Open on GitHub" href={url} />
      )}
    </header>
  );
}
