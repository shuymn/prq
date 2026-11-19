// The PR detail as the design draws it (design/screens.md, detail.* and panel.*), from its model: on a page, a main
// column (header, summary, conversation, composer) and a rail with the versions and jobs; in the panel one column, the
// header compact and the summary in a disclosure whose row holds the version menu. What is loading, failed or unknown
// takes the summary's and conversation's place.

import "./PrDetail.css";
import type { ReactNode, Ref } from "react";

import { Button, ButtonLink } from "../components/Button.tsx";
import { Composer } from "../components/Composer.tsx";
import { ConnectionBanner } from "../components/ConnectionBanner.tsx";
import { Disclosure } from "../components/Disclosure.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { JobRow } from "../components/JobRow.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Message } from "../components/Message.tsx";
import { Notice } from "../components/Notice.tsx";
import { PrHeader } from "../components/PrHeader.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { Summary } from "../components/Summary.tsx";
import { VersionItem } from "../components/VersionItem.tsx";
import { VersionMenu } from "../components/VersionMenu.tsx";
import type { Layout } from "../layout.ts";
import type { AnswerItem, DetailContent, DetailModel, JobItem, QuestionItem } from "./detail-model.ts";

export type DetailActions = {
  onDraft?: ((value: string) => void) | undefined;
  onSend?: ((text: string) => void) | undefined;
  onPick?: ((jobId: string) => void) | undefined;
  onRetrySend?: (() => void) | undefined;
  onDiscard?: (() => void) | undefined;
  // Try again after a failed history read.
  onReadAgain?: (() => void) | undefined;
  onReload?: (() => void) | undefined;
};

const content = (text: string) => (text === "" ? undefined : <Markdown text={text} />);

function ConversationItem({ item, actions }: { item: QuestionItem | AnswerItem; actions: DetailActions }) {
  if (item.kind === "question") {
    return (
      <Message
        role="question"
        state={item.state}
        text={item.text}
        at={item.at}
        waiting={item.waiting}
        failure={item.failure}
        onRetry={actions.onRetrySend}
        onDiscard={actions.onDiscard}
      />
    );
  }
  return (
    <Message
      role="answer"
      state={item.state}
      content={content(item.text)}
      running={item.running ?? undefined}
      reason={item.reason}
      sha={item.sha}
      model={item.model}
      tokens={item.tokens}
    />
  );
}

function Job({ job }: { job: JobItem }) {
  return <JobRow state={job.state} density="compact" target={job.target} meta={job.meta} at={job.at} />;
}

function Rail({ body, onPick }: { body: DetailContent | null; onPick?: ((jobId: string) => void) | undefined }) {
  if (body === null) {
    return (
      <aside className="rail" aria-busy="true">
        <section>
          <h2>Versions</h2>
          <div className="skeleton">
            <Skeleton shape="line" />
            <Skeleton shape="line" />
            <Skeleton shape="line" />
          </div>
        </section>
        <section>
          <h2>Jobs</h2>
          <div className="skeleton">
            <Skeleton shape="line" />
            <Skeleton shape="line" />
          </div>
        </section>
      </aside>
    );
  }
  const { versions, shown, jobs } = body;
  return (
    <aside className="rail">
      {versions.length > 0 && (
        <section>
          <h2>Versions</h2>
          <div className="versions">
            {versions.map((version) => (
              <VersionItem
                key={version.jobId}
                status={version.status}
                selected={version.jobId === shown?.jobId}
                sha={version.sha}
                at={version.at}
                onSelect={() => onPick?.(version.jobId)}
              />
            ))}
          </div>
        </section>
      )}
      {jobs.active.length + jobs.done.length > 0 && (
        <section>
          <h2>Jobs</h2>
          <div className="jobs">
            {jobs.active.map((job) => (
              <Job key={job.jobId} job={job} />
            ))}
            {jobs.done.length > 0 && (
              <Disclosure label={`${jobs.done.length} done`}>
                <div className="jobs">
                  {jobs.done.map((job) => (
                    <Job key={job.jobId} job={job} />
                  ))}
                </div>
              </Disclosure>
            )}
          </div>
        </section>
      )}
    </aside>
  );
}

function SummarySection({
  body,
  layout,
  menuOpen,
  onPick,
}: {
  body: DetailContent | null;
  layout: Layout;
  menuOpen: boolean;
  onPick?: ((jobId: string) => void) | undefined;
}) {
  const version =
    body?.shown === null || body?.shown === undefined ? undefined : (
      <VersionMenu versions={body.versions} shown={body.shown} open={menuOpen} onSelect={onPick} />
    );
  const summary = body?.summary;
  const shown =
    summary === undefined ? (
      <Summary state="loading" heading={layout === "page"} />
    ) : (
      <Summary
        state={summary.state}
        heading={layout === "page"}
        version={version}
        summarizing={body?.summarizing}
        content={summary.state === "empty" ? undefined : content(summary.text)}
        running={summary.state === "empty" ? undefined : (summary.running ?? undefined)}
        meta={summary.state === "empty" ? null : summary.meta}
        waiting={summary.state === "empty" ? summary.waiting : undefined}
      />
    );
  return layout === "page" ? (
    shown
  ) : (
    <Disclosure label="Summary" heading defaultOpen meta={version}>
      {shown}
    </Disclosure>
  );
}

function Conversation({
  body,
  layout,
  actions,
}: {
  body: DetailContent | null;
  layout: Layout;
  actions: DetailActions;
}) {
  return (
    <section className="conversation" aria-label={layout === "panel" ? "Conversation" : undefined}>
      {layout === "page" && <h2>Conversation</h2>}
      {body === null && (
        <div className="skeleton" aria-busy="true">
          <Skeleton shape="line" />
          <Skeleton shape="block" />
          <Skeleton shape="line" />
          <Skeleton shape="block" />
        </div>
      )}
      {body?.conversation.length === 0 && <p className="none">No questions yet. Ask about this pull request below.</p>}
      {body?.conversation.map((item) => (
        <ConversationItem key={item.id} item={item} actions={actions} />
      ))}
    </section>
  );
}

export function PrDetail({
  layout,
  model,
  notice,
  unsent = false,
  draft,
  fieldRef,
  menuOpen = false,
  composerPreview,
  actions = {},
}: {
  layout: Layout;
  model: DetailModel;
  notice?: ReactNode;
  // A question history has yet to hold: reloading loses it.
  unsent?: boolean | undefined;
  draft: string;
  fieldRef?: Ref<HTMLTextAreaElement> | undefined;
  // The version menu opens once it renders (the gallery's panel.version-menu).
  menuOpen?: boolean | undefined;
  composerPreview?: "focus" | undefined;
  actions?: DetailActions | undefined;
}) {
  const { header, body, banner, composer } = model;
  if (body.kind === "unknown") {
    return (
      <div className="pr-detail" data-layout={layout}>
        <div className="main">
          {banner !== null && <ConnectionBanner state={banner} unsent={unsent} onReload={actions.onReload} />}
          {notice}
          <EmptyState
            icon="git-pull-request"
            title="Unknown pull request"
            text={`prq has nothing for ${header === null ? "this pull request" : `${header.repository}#${header.number}`}. A pull request appears once the GitHub App receives a webhook for it.`}
            heading="h1"
            actions={<ButtonLink variant="secondary" size="md" label="Go to pull requests" href="/" />}
          />
        </div>
      </div>
    );
  }
  const ready = body.kind === "ready" ? body : null;
  const tryAgain = <Button variant="secondary" size="sm" label="Try again" onClick={actions.onReadAgain} />;
  return (
    <div className="pr-detail" data-layout={layout}>
      <div className="main">
        {banner !== null && <ConnectionBanner state={banner} unsent={unsent} onReload={actions.onReload} />}
        {notice}
        {header !== null && (
          <PrHeader
            density={layout === "page" ? "full" : "compact"}
            state={header.state}
            repository={header.repository}
            number={header.number}
            title={header.title}
            url={header.url}
          />
        )}
        {body.kind === "load-failed" ? (
          <Notice tone="danger" title="Couldn't load the summary and conversation" actions={tryAgain} />
        ) : (
          <>
            {ready?.refreshFailed === true && (
              <Notice
                tone="danger"
                title="Couldn't refresh the summary and conversation"
                text="Showing what was loaded before."
                actions={tryAgain}
              />
            )}
            <SummarySection body={ready} layout={layout} menuOpen={menuOpen} onPick={actions.onPick} />
            <Conversation body={ready} layout={layout} actions={actions} />
            <Composer
              value={draft}
              onChange={actions.onDraft}
              onSend={actions.onSend}
              loading={composer.loading}
              down={composer.down}
              held={composer.held}
              answeredAt={composer.answeredAt}
              fieldRef={fieldRef}
              preview={composerPreview}
            />
          </>
        )}
      </div>
      {layout === "page" && body.kind !== "load-failed" && <Rail body={ready} onPick={actions.onPick} />}
    </div>
  );
}
