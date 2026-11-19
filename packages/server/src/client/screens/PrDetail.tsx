// The PR detail as the design draws it (design/screens.md, detail.* and panel.*), from its model: on a page, a main
// column (header, summary, conversation, composer) and a rail with its toggle, the versions and jobs, which collapses
// to the toggle; in the panel one column, the header compact and the summary in a disclosure whose row holds the
// version menu. What is loading, failed or unknown takes the summary's and conversation's place.

import "./PrDetail.css";
import type { ReactNode, Ref } from "react";

import { Button, ButtonLink } from "../components/Button.tsx";
import { Composer } from "../components/Composer.tsx";
import { ConnectionBanner } from "../components/ConnectionBanner.tsx";
import { Disclosure } from "../components/Disclosure.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Icon } from "../components/Icon.tsx";
import { IconButton } from "../components/IconButton.tsx";
import { JobRow } from "../components/JobRow.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Message } from "../components/Message.tsx";
import { Notice } from "../components/Notice.tsx";
import { PrHeader } from "../components/PrHeader.tsx";
import { useElapsed } from "../components/RelativeTime.tsx";
import { RetryButton, RetryError } from "../components/retry.tsx";
import { shortSha } from "../components/Sha.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { Summary } from "../components/Summary.tsx";
import { VersionItem } from "../components/VersionItem.tsx";
import { VersionMenu } from "../components/VersionMenu.tsx";
import type { Layout } from "../layout.ts";
import type { AnswerItem, DetailContent, DetailModel, JobItem, QuestionItem, RetryControl } from "./detail-model.ts";

type DetailActions = {
  onDraft?: ((value: string) => void) | undefined;
  onSend?: ((text: string) => void) | undefined;
  onPick?: ((jobId: string) => void) | undefined;
  onRetrySend?: (() => void) | undefined;
  onDiscard?: (() => void) | undefined;
  // Try again after a failed history read.
  onReadAgain?: (() => void) | undefined;
  onReload?: (() => void) | undefined;
  // The panel's back control.
  onBack?: (() => void) | undefined;
  // A job's Retry, from the revision shown.
  onRetryJob?: ((jobId: string, rev: number) => void) | undefined;
  onToggleRail?: (() => void) | undefined;
};

const content = (text: string) => (text === "" ? undefined : <Markdown text={text} />);

// A reason as a sentence: its first letter capitalized and a period at its end.
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;

const retryAction = (retry: RetryControl | null, actions: DetailActions) =>
  retry === null ? undefined : () => actions.onRetryJob?.(retry.jobId, retry.rev);

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
      retry={item.retry?.state}
      onRetry={retryAction(item.retry, actions)}
      sha={item.sha}
      model={item.model}
      tokens={item.tokens}
    />
  );
}

// A running job's meta ends with how long it has run ("(12 min)"), a possibly stalled one's with how long its claim has
// had no result ("· no result after 64 min").
function Job({ job, actions }: { job: JobItem; actions: DetailActions }) {
  const elapsed = useElapsed(job.since);
  const meta =
    elapsed === null
      ? job.meta
      : job.state === "stalled"
        ? `${job.meta} · no result after ${elapsed}`
        : `${job.meta} (${elapsed})`;
  return (
    <JobRow
      state={job.state}
      density="compact"
      target={job.target}
      meta={meta}
      at={job.at}
      retry={job.retry?.state}
      onRetry={retryAction(job.retry, actions)}
    />
  );
}

// The rail's head: the toggle that hides the rail's versions and jobs and shows them again, named the same either way
// with aria-expanded saying which; collapsed, while a job has failed or is possibly stalled, it carries a danger dot,
// which its description says.
function RailHead({
  collapsed,
  attention,
  onToggle,
}: {
  collapsed: boolean;
  attention: boolean;
  onToggle?: (() => void) | undefined;
}) {
  const alert = collapsed && attention;
  return (
    <div className="rail-head">
      <span className="rail-toggle">
        <IconButton
          variant="invisible"
          size="md"
          icon={collapsed ? "sidebar-expand" : "sidebar-collapse"}
          label="Jobs and versions"
          expanded={!collapsed}
          description={alert ? "A job needs attention" : undefined}
          onClick={onToggle}
        />
        {alert && (
          <span className="alert">
            <Icon name="dot-fill" />
          </span>
        )}
      </span>
    </div>
  );
}

// The rail: its head, then, expanded, the versions and the jobs (skeletons until the session's first view).
function Rail({
  body,
  collapsed,
  actions,
}: {
  body: DetailContent | null;
  collapsed: boolean;
  actions: DetailActions;
}) {
  const attention = body?.jobs.active.some((job) => job.state === "failed" || job.state === "stalled") === true;
  return (
    <aside className="rail" aria-busy={!collapsed && body === null ? true : undefined}>
      <RailHead collapsed={collapsed} attention={attention} onToggle={actions.onToggleRail} />
      {!collapsed && (body === null ? <RailLoading /> : <RailContent body={body} actions={actions} />)}
    </aside>
  );
}

function RailLoading() {
  return (
    <>
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
    </>
  );
}

function RailContent({ body, actions }: { body: DetailContent; actions: DetailActions }) {
  const { versions, shown, jobs } = body;
  return (
    <>
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
                onSelect={() => actions.onPick?.(version.jobId)}
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
              <Job key={job.jobId} job={job} actions={actions} />
            ))}
            {jobs.done.length > 0 && (
              <Disclosure label={`${jobs.done.length} done`}>
                <div className="jobs">
                  {jobs.done.map((job) => (
                    <Job key={job.jobId} job={job} actions={actions} />
                  ))}
                </div>
              </Disclosure>
            )}
          </div>
        </section>
      )}
    </>
  );
}

// The newest analysis failed: a Notice with the reason, the summary shown instead, and Retry.
function FailedAnalysis({ failed, actions }: { failed: NonNullable<DetailContent["failed"]>; actions: DetailActions }) {
  const below = failed.shown === null ? "" : ` The summary below is for ${shortSha(failed.shown)}.`;
  return (
    <Notice
      tone="danger"
      title={`Summary of ${shortSha(failed.sha)} failed`}
      text={`${sentence(failed.reason)}${below}`}
      actions={
        failed.retry === null ? undefined : (
          <>
            <RetryButton state={failed.retry.state} onRetry={retryAction(failed.retry, actions)} />
            {failed.retry.state === "failed" && <RetryError />}
          </>
        )
      }
    />
  );
}

function SummarySection({
  body,
  layout,
  menuOpen,
  actions,
}: {
  body: DetailContent | null;
  layout: Layout;
  menuOpen: boolean;
  actions: DetailActions;
}) {
  const version =
    body?.shown === null || body?.shown === undefined ? undefined : (
      <VersionMenu versions={body.versions} shown={body.shown} open={menuOpen} onSelect={actions.onPick} />
    );
  const summary = body?.summary;
  const stalled = body?.stalled ?? null;
  const elapsed = useElapsed(stalled?.since ?? null);
  const shown =
    summary === undefined ? (
      <Summary state="loading" heading={layout === "page"} />
    ) : (
      <Summary
        state={summary.state}
        heading={layout === "page"}
        version={version}
        summarizing={body?.summarizing}
        stalled={
          stalled === null
            ? null
            : {
                sha: stalled.sha,
                detail: `possibly stalled: no result from ${stalled.agent}${elapsed === null ? "" : ` after ${elapsed}`}`,
              }
        }
        retry={stalled?.retry?.state}
        onRetry={retryAction(stalled?.retry ?? null, actions)}
        notice={
          body?.failed === null || body?.failed === undefined ? undefined : (
            <FailedAnalysis failed={body.failed} actions={actions} />
          )
        }
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
  railCollapsed = false,
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
  // The rail collapsed to its toggle (the page's layout only).
  railCollapsed?: boolean | undefined;
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
    <div className="pr-detail" data-layout={layout} data-rail={railCollapsed ? "collapsed" : "expanded"}>
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
            onBack={actions.onBack}
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
            <SummarySection body={ready} layout={layout} menuOpen={menuOpen} actions={actions} />
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
      {layout === "page" && body.kind !== "load-failed" && (
        <Rail body={ready} collapsed={railCollapsed} actions={actions} />
      )}
    </div>
  );
}
