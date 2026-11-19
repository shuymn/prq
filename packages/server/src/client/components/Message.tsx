import "./Message.css";
import type { ReactNode } from "react";

import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { RelativeTime } from "./RelativeTime.tsx";
import { Sha } from "./Sha.tsx";
import { Status } from "./Status.tsx";

export type QuestionState = "sent" | "queued" | "waiting-agent" | "send-failed";
export type AnswerState = "streaming" | "complete" | "incomplete";

type QuestionProps = {
  role: "question";
  state: QuestionState;
  text: string;
  // When it was asked, when known.
  at?: number | null | undefined;
  // Why it waits (queued, waiting-agent).
  waiting?: string | undefined;
  // A failed send: whether the read after it lacked the question, or none completed.
  failure?: "not-sent" | "unconfirmed" | undefined;
  onRetry?: (() => void) | undefined;
  onDiscard?: (() => void) | undefined;
};

type AnswerProps = {
  role: "answer";
  state: AnswerState;
  // The answer's text, rendered (Markdown); none while a turn has yet to write.
  content?: ReactNode | undefined;
  // A turn under way: who runs it and since when ("cloud · started 10:14").
  running?: ReactNode | undefined;
  // Why an incomplete answer stopped.
  reason?: string | undefined;
  // The workspace SHA it was answered at, the model and the tokens a cloud result used.
  sha?: string | null | undefined;
  model?: string | null | undefined;
  tokens?: number | null | undefined;
};

export const FAILURES = { "not-sent": "Not sent", unconfirmed: "Couldn't confirm it was sent" } as const;

const count = new Intl.NumberFormat("en");

// A message of the conversation (design/components.md, PR detail): a question with how its send went and why it
// waits, or an answer under its question, streaming with its running line, complete, or incomplete with the reason,
// and what it was answered at.
export function Message(props: QuestionProps | AnswerProps) {
  if (props.role === "question") {
    const { state, text, at, waiting, failure, onRetry, onDiscard } = props;
    return (
      <article data-component="Message" data-role="question" data-state={state}>
        <span className="lead">
          <Icon name="comment" />
        </span>
        <div className="column">
          <p className="header">
            <span>You</span>
            {at !== undefined && at !== null && <RelativeTime at={at} />}
          </p>
          <div className="content">
            <p className="question">{text}</p>
            {waiting !== undefined && <Status state="waiting" label={waiting} />}
            {failure !== undefined && (
              <div className="failure">
                <Status state="failed" label={FAILURES[failure]} />
                <div className="actions">
                  <Button variant="secondary" size="sm" label="Try again" onClick={onRetry} />
                  <Button variant="invisible" size="sm" label="Discard" onClick={onDiscard} />
                </div>
              </div>
            )}
          </div>
        </div>
      </article>
    );
  }
  const { state, content, running, reason, sha, model, tokens } = props;
  const usage = [model, tokens === undefined || tokens === null ? null : `${count.format(tokens)} tokens`].filter(
    (part) => part !== undefined && part !== null,
  );
  return (
    <article data-component="Message" data-role="answer" data-state={state}>
      <span className="lead" />
      <div className="column rule">
        <div className="body">
          {content}
          {state === "streaming" && content === undefined && <span className="caret" aria-hidden="true" />}
        </div>
        {running !== undefined && (
          <p className="running">
            <Status state="running" label="Answering" />
            <span>{running}</span>
          </p>
        )}
        {state === "incomplete" && reason !== undefined && <Status state="failed" label={`Incomplete — ${reason}`} />}
        {((sha !== undefined && sha !== null) || usage.length > 0) && (
          <p className="meta">
            {sha !== undefined && sha !== null && (
              <span className="answered-at">
                Answered at <Sha sha={sha} />
              </span>
            )}
            {usage.length > 0 && <span>{usage.join(" · ")}</span>}
          </p>
        )}
      </div>
    </article>
  );
}
