import "./PrHeader.css";
import { ButtonLink } from "./Button.tsx";
import { IconButton, IconButtonLink } from "./IconButton.tsx";
import { type PrState, PrStateLabel } from "./PrStateLabel.tsx";

// The pull request a detail page is about (design/components.md, PR detail): its state, repository and number, its
// title as the page's heading, and a link to it on GitHub. Compact is the panel's, which has no AppHeader: it starts
// with the back control to the PR list, and has a smaller title and an icon link.
export function PrHeader({
  density,
  state,
  repository,
  number,
  title,
  url,
  onBack,
}: {
  density: "full" | "compact";
  // Null until the pull request's first webhook.
  state: PrState | null;
  repository: string;
  number: number;
  title: string;
  url: string;
  onBack?: (() => void) | undefined;
}) {
  return (
    <header data-component="PrHeader" data-density={density}>
      {density === "compact" && (
        <IconButton variant="invisible" size="md" icon="chevron-left" label="Back to pull requests" onClick={onBack} />
      )}
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
        <IconButtonLink icon="link-external" label="Open on GitHub" href={url} external />
      )}
    </header>
  );
}
