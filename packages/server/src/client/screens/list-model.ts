// The PR list's rows and body from the ledger's snapshot and the Hub's view: how the list names a repository, and
// which empty state it shows.

import { type LedgerRow, sessionName } from "@prq/protocol";

import type { LedgerSnapshot } from "../ledger.ts";
import type { ListBody, ListRow } from "./PrList.tsx";

// A repository as the list names it: without its owner while every pull request has one owner (HubView.owners).
export function repositoryName(fullName: string, owners: number | undefined): string {
  return owners === 1 ? fullName.slice(fullName.indexOf("/") + 1) : fullName;
}

function listRow(row: LedgerRow, owners: number | undefined): ListRow {
  const { pr, details, latestEvent, problem } = row;
  const fullName = details?.fullName ?? `${pr.owner}/${pr.repo}`;
  return {
    key: sessionName(pr),
    title: details?.title ?? "",
    repository: repositoryName(fullName, owners),
    number: pr.number,
    state: details?.state ?? "open",
    event: latestEvent?.kind ?? null,
    eventTime: latestEvent?.at ?? null,
    problem,
    href: `/pr/${fullName}/${pr.number}`,
  };
}

// The body for the snapshot: the onboarding copy only when the ledger is known empty (an unfiltered read with no
// rows, or the Hub's view counting no owner), otherwise the filter's copy.
export function listBody(snapshot: LedgerSnapshot, owners: number | undefined): ListBody {
  const { rows, filter } = snapshot;
  if (rows === null) {
    return snapshot.failure === "load" ? { kind: "load-failed" } : { kind: "loading" };
  }
  if (rows.length > 0) {
    return {
      kind: "rows",
      rows: rows.map((row) => listRow(row, owners)),
      more: snapshot.more,
      loadingMore: snapshot.loadingMore,
    };
  }
  if (filter.attention) {
    return { kind: "empty", reason: "attention" };
  }
  if (owners === 0 || (filter.state === "all" && filter.repo === null)) {
    return { kind: "empty", reason: "ledger" };
  }
  return { kind: "empty", reason: filter.repo === null ? "open" : "repo" };
}
