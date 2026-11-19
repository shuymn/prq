import "./PrRow.css";
import type { LatestEvent, Problem } from "@prq/protocol";
import type { ComponentProps } from "react";

import { Icon } from "./Icon.tsx";
import { PR_STATE_ICONS, PR_STATE_LABELS, type PrState } from "./PrStateLabel.tsx";
import { RelativeTime } from "./RelativeTime.tsx";
import { Status } from "./Status.tsx";

const EVENTS: Record<LatestEvent["kind"], string> = {
  summary: "Summary",
  answer: "Answer",
  push: "Push received",
  question: "Question sent",
};

// A problem as the Status column shows it (design/components.md, PR list).
const PROBLEMS: Record<Problem, ComponentProps<typeof Status>> = {
  summary_failed: { state: "failed", label: "Summary failed" },
  answer_failed: { state: "failed", label: "Answer failed" },
  possibly_stalled: { state: "stalled", label: "Possibly stalled" },
  waiting_for_local_agent: { state: "waiting", label: "Waiting for a local agent" },
  new_push_not_summarized: { state: "waiting", icon: "history", label: "New push not summarized" },
};

// The repository as the list names it: `owner/name`, or the name alone while every pull request has one owner. A
// name that does not fit cuts its owner first.
function Repository({ repository }: { repository: string }) {
  const slash = repository.indexOf("/");
  return (
    <span className="repo">
      {slash >= 0 && <span className="owner">{repository.slice(0, slash + 1)}</span>}
      {repository.slice(slash + 1)}
    </span>
  );
}

// One pull request in the list (design/components.md, PR list): its repository, its state, title and number, which
// open it, the problem the host can act on if there is one, and its latest event.
export function PrRow({
  title,
  repository,
  number,
  state,
  latestEvent,
  problem,
  href,
}: {
  title: string;
  repository: string;
  number: number;
  state: PrState;
  latestEvent: LatestEvent | null;
  problem: Problem | null;
  href: string;
}) {
  return (
    <tr data-component="PrRow">
      <td className="repo-cell">
        <Repository repository={repository} />
      </td>
      <td className="pr-cell">
        <span className="state-icon" data-state={state}>
          <Icon name={PR_STATE_ICONS[state]} label={PR_STATE_LABELS[state]} />
        </span>
        <a className="title" href={href}>
          {title}
        </a>
        <span className="number">#{number}</span>
      </td>
      <td className="problem-cell">{problem !== null && <Status {...PROBLEMS[problem]} />}</td>
      <td className="event-cell">
        {latestEvent !== null && (
          <>
            <span className="event">{EVENTS[latestEvent.kind]}</span>
            <RelativeTime at={latestEvent.at} />
          </>
        )}
      </td>
    </tr>
  );
}
