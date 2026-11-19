import "./PrList.css";
import { type ComponentProps, type ReactNode, useEffect, useRef } from "react";

import { Button } from "../components/Button.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Notice } from "../components/Notice.tsx";
import { PrRow } from "../components/PrRow.tsx";
import { PrTableHeader } from "../components/PrTableHeader.tsx";
import { RepoFilter } from "../components/RepoFilter.tsx";
import type { RepoItems } from "../components/RepoMenu.tsx";
import { SegmentedControl } from "../components/SegmentedControl.tsx";
import { Skeleton } from "../components/Skeleton.tsx";

export type ListRow = ComponentProps<typeof PrRow> & { key: string };

// What the list shows in the table's place.
export type ListBody =
  | { kind: "loading" }
  | { kind: "load-failed" }
  // No rows: the ledger has none at all (the onboarding copy), or none pass the filter.
  | { kind: "empty"; reason: "ledger" | "open" | "repo" | "attention" }
  | { kind: "rows"; rows: ListRow[]; more: boolean; loadingMore: boolean };

const EMPTY = {
  ledger: {
    title: "No pull requests yet",
    text: "Pull requests appear when the GitHub App receives a webhook for your own pull request.",
  },
  open: { title: "No open pull requests", text: "Choose All to see closed and merged ones." },
  repo: {
    title: "No pull requests match these filters",
    text: "Choose another repository, or All to include closed and merged ones.",
  },
  attention: { title: "Nothing needs attention", text: "Turn off Needs attention to see every pull request." },
};

// The rows a page of skeletons shows while the first pass loads, and while the next page loads after the last row.
const LOADING_ROWS = 6;
const NEXT_PAGE_ROWS = 3;

function SkeletonRows({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => (
    <tr key={index} className="skeleton-row" data-width={index % 2 === 0 ? "short" : "long"}>
      <td className="repo-cell">
        <Skeleton shape="line" />
      </td>
      <td className="pr-cell">
        <span className="skeleton-icon">
          <Skeleton shape="line" />
        </span>
        <span className="skeleton-title">
          <Skeleton shape="line" />
        </span>
      </td>
      <td className="problem-cell" />
      <td className="event-cell">
        <Skeleton shape="line" />
      </td>
    </tr>
  ));
}

// Reads the next page when the end of the rows comes into view.
function NextPage({ onLoadMore }: { onLoadMore: () => void }) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (element === null) {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onLoadMore();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onLoadMore]);
  return <div ref={sentinel} className="next-page" />;
}

// The PR list (design/screens.md, PR list): the page title and the filters, then the table of pull requests, its
// loading, failure and empty states. A notice about the build, when there is one, comes first.
export function PrList({
  notice,
  body,
  refreshFailed,
  needsAttention,
  attention,
  state,
  repoLabel,
  repo,
  repoItems,
  repoMenuOpen,
  onAttention,
  onState,
  onRepoRead,
  onRepo,
  onRetry,
  onLoadMore,
}: {
  notice?: ReactNode | undefined;
  body: ListBody;
  refreshFailed: boolean;
  // The rows needing attention, from the Hub's view (0 hides the filter).
  needsAttention: number;
  attention: boolean;
  state: "open" | "all";
  repoLabel: string;
  repo: string | null;
  repoItems: RepoItems;
  // The gallery's list.repo-menu: the repository menu open when the list renders.
  repoMenuOpen?: boolean | undefined;
  onAttention?: (() => void) | undefined;
  onState?: ((state: "open" | "all") => void) | undefined;
  // Reads the repositories, on each opening of the menu and on its Try again.
  onRepoRead?: (() => void) | undefined;
  onRepo?: ((repo: string | null) => void) | undefined;
  onRetry?: (() => void) | undefined;
  onLoadMore?: (() => void) | undefined;
}) {
  const tryAgain = <Button variant="secondary" size="sm" label="Try again" onClick={onRetry} />;
  const showAttention =
    needsAttention > 0 && body.kind !== "loading" && !(body.kind === "empty" && body.reason === "ledger");
  return (
    <div className="pr-list">
      {notice}
      <div className="toolbar">
        <h1 tabIndex={-1}>Pull requests</h1>
        <div className="filters">
          {showAttention && (
            <Button
              variant="secondary"
              size="md"
              label={`Needs attention · ${needsAttention}`}
              pressed={attention}
              onClick={onAttention}
            />
          )}
          <RepoFilter
            label={repoLabel}
            selected={repo}
            items={repoItems}
            open={repoMenuOpen}
            onRead={onRepoRead}
            onSelect={onRepo}
          />
          <SegmentedControl
            label="State"
            first="Open"
            second="All"
            selected={state === "open" ? "first" : "second"}
            onSelect={(segment) => onState?.(segment === "first" ? "open" : "all")}
          />
        </div>
      </div>
      {refreshFailed && (
        <Notice
          tone="danger"
          title="Couldn't refresh pull requests"
          text="Showing what was loaded before."
          actions={tryAgain}
        />
      )}
      {body.kind === "load-failed" && <Notice tone="danger" title="Couldn't load pull requests" actions={tryAgain} />}
      {body.kind === "empty" && (
        <EmptyState icon="git-pull-request" title={EMPTY[body.reason].title} text={EMPTY[body.reason].text} />
      )}
      {(body.kind === "loading" || body.kind === "rows") && (
        <table className="pr-table" aria-busy={body.kind === "loading" || body.loadingMore}>
          <PrTableHeader />
          <tbody>
            {body.kind === "loading" ? (
              <SkeletonRows count={LOADING_ROWS} />
            ) : (
              <>
                {body.rows.map(({ key, ...row }) => (
                  <PrRow key={key} {...row} />
                ))}
                {body.loadingMore && <SkeletonRows count={NEXT_PAGE_ROWS} />}
              </>
            )}
          </tbody>
        </table>
      )}
      {body.kind === "rows" && body.more && !body.loadingMore && !refreshFailed && onLoadMore !== undefined && (
        <NextPage onLoadMore={onLoadMore} />
      )}
    </div>
  );
}
