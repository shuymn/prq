// The gallery's entries (plan §1.17): one per component name of design/components.md and one per state ID of
// design/screens.md, as far as the UI has them (registry.test.tsx holds the rest as pending). A component entry renders
// the real component with the props its name gives, so its root carries them as data-<prop>; a state entry renders
// the real screen from fixtures. State IDs that share a frame share one rendering.

import type { HubView, LedgerRow } from "@prq/protocol";
import type { ReactNode } from "react";

import { AppHeader } from "../components/AppHeader.tsx";
import { Badge, type BadgeTone } from "../components/Badge.tsx";
import { BrandMark } from "../components/BrandMark.tsx";
import { Button, type ButtonVariant, type ControlSize } from "../components/Button.tsx";
import { CodeBlock } from "../components/CodeBlock.tsx";
import { Composer } from "../components/Composer.tsx";
import { ConnectionBanner } from "../components/ConnectionBanner.tsx";
import { Disclosure } from "../components/Disclosure.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Icon, ICON_NAMES } from "../components/Icon.tsx";
import { IconButton } from "../components/IconButton.tsx";
import { JobRow, type JobRowState } from "../components/JobRow.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Message } from "../components/Message.tsx";
import { Notice, type NoticeTone } from "../components/Notice.tsx";
import { PoolStatus } from "../components/PoolStatus.tsx";
import { PrHeader } from "../components/PrHeader.tsx";
import { PrRow } from "../components/PrRow.tsx";
import { type PrState, PrStateLabel } from "../components/PrStateLabel.tsx";
import { PrTableHeader } from "../components/PrTableHeader.tsx";
import { RelativeTime } from "../components/RelativeTime.tsx";
import { RepoFilter } from "../components/RepoFilter.tsx";
import { ALL_REPOSITORIES, RepoMenu, type RepoItems } from "../components/RepoMenu.tsx";
import { RepoMenuItem } from "../components/RepoMenuItem.tsx";
import { SegmentedControl } from "../components/SegmentedControl.tsx";
import { Sha } from "../components/Sha.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { Status, type StatusState } from "../components/Status.tsx";
import { Summary } from "../components/Summary.tsx";
import { VersionItem, type VersionStatus } from "../components/VersionItem.tsx";
import { type Version, VersionMenu } from "../components/VersionMenu.tsx";
import { Frame } from "../frame.tsx";
import type { Layout } from "../layout.ts";
import { BuildNotice } from "../notices.tsx";
import { detailModel } from "../screens/detail-model.ts";
import { listBody } from "../screens/list-model.ts";
import { PrDetail } from "../screens/PrDetail.tsx";
import { PrList } from "../screens/PrList.tsx";
import { DETAIL_FIXTURES, type DetailFixture, HEADS, SUMMARY } from "./detail-fixtures.ts";
import { allRows, CLOUD_ONLY, defaultRows, EMPTY_LOCAL, menuRepos } from "./fixtures.ts";

export type Entry = { name: string; render: () => ReactNode };

const VERSION = "v0.4.0";

const variants = <T extends string>(component: string, values: readonly T[], render: (value: T) => ReactNode) =>
  values.map((value): Entry => ({ name: `${component}/${value}`, render: () => render(value) }));

// Button and IconButton: each variant and size in each state; hover and focus are previews of CSS states.
function controlEntries(): Entry[] {
  const entries: Entry[] = [];
  for (const variant of ["primary", "secondary", "danger", "invisible"] as ButtonVariant[]) {
    for (const size of ["md", "sm"] as ControlSize[]) {
      for (const state of ["rest", "hover", "focus", "disabled", "busy"] as const) {
        entries.push({
          name: `Button/${variant}/${size}/${state}`,
          render: () => (
            <Button
              variant={variant}
              size={size}
              label="Button"
              disabled={state === "disabled"}
              busy={state === "busy"}
              preview={state === "hover" || state === "focus" ? state : undefined}
            />
          ),
        });
      }
    }
  }
  for (const variant of ["invisible", "secondary"] as const) {
    for (const size of ["md", "sm"] as ControlSize[]) {
      for (const state of ["rest", "hover", "focus"] as const) {
        entries.push({
          name: `IconButton/${variant}/${size}/${state}`,
          render: () => (
            <IconButton
              variant={variant}
              size={size}
              icon="x"
              label="Close"
              preview={state === "rest" ? undefined : state}
            />
          ),
        });
      }
    }
  }
  return entries;
}

// The PR list over a pass that completed with these rows (null: still loading), under Open or All, its repository menu
// open over it with these items where they are given.
function ListState({
  view,
  rows,
  state = "open",
  notice,
  repoMenu,
}: {
  view: HubView;
  rows: LedgerRow[] | null;
  state?: "open" | "all";
  notice?: ReactNode;
  repoMenu?: RepoItems;
}) {
  const filter = { attention: false, state, repo: null } as const;
  const body = listBody({ rows, filter, more: false, loadingMore: false, failure: null }, view.owners);
  return (
    <Frame view={view} version={VERSION} layout="page">
      <PrList
        notice={notice}
        body={body}
        refreshFailed={false}
        needsAttention={view.needsAttention}
        attention={false}
        state={state}
        repoLabel={ALL_REPOSITORIES}
        repo={null}
        repoItems={repoMenu ?? { state: "loading" }}
        repoMenuOpen={repoMenu !== undefined}
      />
    </Frame>
  );
}

const listDefault = () => <ListState view={CLOUD_ONLY} rows={defaultRows(Date.now())} />;

// The PR detail from a session as the store holds it, through the same model the screen uses.
function DetailState({ data, layout, menuOpen = false }: { data: DetailFixture; layout: Layout; menuOpen?: boolean }) {
  const unsent = data.slot !== null;
  return (
    <Frame view={data.hub} version={VERSION} layout={layout} header={layout === "page"}>
      <PrDetail
        layout={layout}
        model={detailModel(data)}
        notice={
          data.newVersion === true ? (
            <BuildNotice serverVersions={["v0.5.0"]} assetFailed={false} unsent={unsent} />
          ) : undefined
        }
        unsent={unsent}
        draft={data.draft ?? ""}
        menuOpen={menuOpen}
      />
    </Frame>
  );
}

const fixtureOf = (name: string): DetailFixture => {
  const found = DETAIL_FIXTURES[name];
  if (found === undefined) {
    throw new Error(`no detail fixture ${name}`);
  }
  return found(Date.now());
};
const detail = (name: string) => () => <DetailState data={fixtureOf(name)} layout="page" />;
const panel =
  (name: string, menuOpen = false) =>
  () => <DetailState data={fixtureOf(name)} layout="panel" menuOpen={menuOpen} />;

const shownVersion = (now: number): Version => ({
  jobId: "a-latest",
  status: "done",
  sha: HEADS.latest,
  at: now - 5 * 60_000,
});
const VERSIONS = (now: number): Version[] => [
  { jobId: "a-newer", status: "running", sha: HEADS.newer, at: now },
  shownVersion(now),
  { jobId: "a-superseded", status: "superseded", sha: HEADS.superseded, at: now - 60 * 60_000 },
  { jobId: "a-older", status: "failed", sha: HEADS.older, at: now - 2 * 60 * 60_000 },
];

const JOB_META: Record<JobRowState, string> = {
  waiting: "Waiting for a local agent since 10:02",
  running: "agent-7f3a · running since 10:02 (12 min)",
  stalled: "agent-7f3a · running since 09:02",
  failed: "Step limit reached · agent-7f3a",
  done: "agent-7f3a · 12,480 tokens",
};

// The PR detail's components, each with its name's props.
function detailEntries(): Entry[] {
  const now = Date.now();
  const code = "export async function retry(job) {\n  await backoff(job.attempt);\n  return run(job);\n}";
  return [
    ...variants("ConnectionBanner", ["reconnecting", "failed"] as const, (state) => <ConnectionBanner state={state} />),
    ...variants("Disclosure", ["true", "false"] as const, (open) => (
      <Disclosure label="2 done" defaultOpen={open === "true"}>
        <JobRow state="done" density="compact" target={{ kind: "analysis", sha: HEADS.older }} meta={JOB_META.done} />
      </Disclosure>
    )),
    ...variants("PrHeader", ["full", "compact"] as const, (density) => (
      <PrHeader
        density={density}
        state="open"
        repository="acme/api"
        number={128}
        title="Retry failed webhooks with backoff"
        url="https://github.com/acme/api/pull/128"
      />
    )),
    { name: "CodeBlock", render: () => <CodeBlock code={code} language="ts" /> },
    { name: "Markdown", render: () => <Markdown text={SUMMARY} /> },
    ...variants("Summary", ["ready", "loading", "streaming", "empty"] as const, (state) => (
      <Summary
        state={state}
        version={<VersionMenu versions={VERSIONS(now)} shown={shownVersion(now)} />}
        content={state === "ready" || state === "streaming" ? <Markdown text={SUMMARY} /> : undefined}
        running={state === "streaming" ? "cloud · started 10:12" : undefined}
        meta={state === "ready" ? "deepseek-chat · 12,480 tokens" : state === "streaming" ? "deepseek-chat" : null}
        waiting={state === "empty" ? "Waiting for a local agent since 10:02 — continues when it returns" : undefined}
      />
    )),
    ...(["done", "running", "waiting", "failed", "superseded"] as VersionStatus[]).flatMap((status) =>
      variants(`VersionItem/${status}`, ["true", "false"] as const, (selected) => (
        <VersionItem status={status} selected={selected === "true"} sha={HEADS.older} at={now - 5 * 60_000} />
      )),
    ),
    ...variants("VersionMenu", ["false", "true"] as const, (open) => (
      <VersionMenu versions={VERSIONS(now)} shown={shownVersion(now)} open={open === "true"} />
    )),
    ...(["waiting", "running", "stalled", "failed", "done"] as JobRowState[]).flatMap((state) =>
      variants(`JobRow/${state}`, ["full", "compact"] as const, (density) => (
        <JobRow
          state={state}
          density={density}
          target={{ kind: "analysis", sha: HEADS.older }}
          meta={JOB_META[state]}
        />
      )),
    ),
    ...variants("Message/question", ["sent", "queued", "waiting-agent", "send-failed"] as const, (state) => (
      <Message
        role="question"
        state={state}
        text="Why does a retry keep the original delivery ID?"
        at={now - 2 * 60_000}
        waiting={
          state === "queued"
            ? "Queued behind the running answer"
            : state === "waiting-agent"
              ? "Waiting for a local agent since 10:02 — continues when it returns"
              : undefined
        }
        failure={state === "send-failed" ? "not-sent" : undefined}
      />
    )),
    ...variants("Message/answer", ["streaming", "complete", "incomplete"] as const, (state) => (
      <Message
        role="answer"
        state={state}
        content={
          <Markdown
            text={
              state === "complete"
                ? `GitHub uses the delivery ID to deduplicate, so a retry must look like the same delivery.\n\n\`\`\`ts\n${code}\n\`\`\``
                : "GitHub uses the delivery ID to deduplicate, so a retry must"
            }
          />
        }
        running={state === "streaming" ? "cloud · started 10:12" : undefined}
        reason={state === "incomplete" ? "step limit reached" : undefined}
        sha={state === "streaming" ? null : HEADS.older}
        model={state === "complete" ? "sonnet-5-5" : null}
        tokens={state === "complete" ? 2310 : null}
      />
    )),
    ...variants("Composer", ["idle", "focus", "disabled"] as const, (state) => (
      <Composer
        value=""
        answeredAt={HEADS.latest}
        down={state === "disabled" ? "reconnecting" : null}
        preview={state === "focus" ? "focus" : undefined}
      />
    )),
  ];
}

export const REGISTRY: Entry[] = [
  // Foundations
  ...variants("Icon", ICON_NAMES, (name) => <Icon name={name} />),
  { name: "Spinner", render: () => <Spinner label="Loading" /> },
  // Status and labels
  ...variants("Status", ["done", "running", "waiting", "stalled", "failed", "superseded"] as StatusState[], (state) => (
    <Status state={state} />
  )),
  ...variants("Badge", ["neutral", "accent", "success", "attention", "danger", "done"] as BadgeTone[], (tone) => (
    <Badge tone={tone} label={tone[0]?.toUpperCase() + tone.slice(1)} />
  )),
  ...variants("PrStateLabel", ["open", "merged", "closed"] as PrState[], (state) => <PrStateLabel state={state} />),
  { name: "Sha", render: () => <Sha sha="a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" /> },
  { name: "RelativeTime", render: () => <RelativeTime at={Date.now() - 5 * 60_000} /> },
  // Controls
  ...controlEntries(),
  ...variants("SegmentedControl", ["first", "second"] as const, (selected) => (
    <SegmentedControl label="State" first="Open" second="All" selected={selected} />
  )),
  // Feedback
  ...variants("Notice", ["info", "attention", "danger"] as NoticeTone[], (tone) => (
    <Notice
      tone={tone}
      title="Analysis queued"
      text="Waiting for a local agent since 10:02. It starts when one returns."
      actions={<Button variant="secondary" size="sm" label="Button" />}
    />
  )),
  {
    name: "EmptyState",
    render: () => (
      <EmptyState
        icon="git-pull-request"
        title="No pull requests yet"
        text="Pull requests appear when the GitHub App receives a webhook for your own pull request."
        actions={<Button variant="secondary" size="md" label="Button" />}
      />
    ),
  },
  ...variants("Skeleton", ["line", "block"] as const, (shape) => <Skeleton shape={shape} />),
  // Layout and navigation
  {
    name: "AppHeader",
    render: () => (
      <AppHeader
        version={VERSION}
        pool={<PoolStatus form="button" state="local" agents={1} jobs={{ running: 1, waiting: 2, failed: 0 }} />}
      />
    ),
  },
  // PR list
  {
    name: "PrTableHeader",
    render: () => (
      <table className="pr-table">
        <PrTableHeader />
      </table>
    ),
  },
  {
    name: "PrRow",
    render: () => (
      <table className="pr-table">
        <tbody>
          <PrRow
            title="Add retry to stalled jobs"
            repository="prq"
            number={42}
            state="open"
            latestEvent={{ kind: "answer", at: Date.now() - 3 * 60_000 }}
            problem="answer_failed"
            href="/pr/shuymn/prq/42"
          />
        </tbody>
      </table>
    ),
  },
  {
    name: "RepoFilter",
    render: () => <RepoFilter label={ALL_REPOSITORIES} selected={null} items={{ state: "loading" }} />,
  },
  ...variants("RepoMenuItem", ["true", "false"] as const, (selected) => (
    <RepoMenuItem label={selected === "true" ? "prq" : "kopje"} selected={selected === "true"} />
  )),
  ...variants("RepoMenu", ["ready", "loading", "failed"] as const, (state) => (
    <RepoMenu
      items={state === "ready" ? { state, repos: menuRepos(["kopje", "prq", "zenith"]) } : { state }}
      selected={state === "ready" ? "shuymn/prq" : null}
    />
  )),
  // PR detail
  ...detailEntries(),
  // Brand
  ...variants("BrandMark", ["brand", "face"] as const, (variant) => <BrandMark variant={variant} size={2} />),
  // 1. PR list
  { name: "list.default", render: listDefault },
  { name: "list.waiting-agent", render: listDefault },
  { name: "list.failed", render: listDefault },
  { name: "list.all", render: () => <ListState view={CLOUD_ONLY} rows={allRows(Date.now())} state="all" /> },
  { name: "list.empty", render: () => <ListState view={EMPTY_LOCAL} rows={[]} /> },
  { name: "list.loading", render: () => <ListState view={CLOUD_ONLY} rows={null} /> },
  {
    name: "list.new-version",
    render: () => (
      <ListState
        view={CLOUD_ONLY}
        rows={defaultRows(Date.now())}
        notice={<BuildNotice serverVersions={["v0.5.0"]} assetFailed={false} />}
      />
    ),
  },
  {
    name: "list.repo-menu",
    render: () => (
      <ListState view={CLOUD_ONLY} rows={defaultRows(Date.now())} repoMenu={{ state: "ready", repos: menuRepos() }} />
    ),
  },
  // 2. PR detail
  { name: "detail.default", render: detail("default") },
  { name: "detail.empty", render: detail("empty") },
  { name: "detail.loading", render: detail("loading") },
  { name: "detail.streaming", render: detail("streaming") },
  { name: "detail.summary-streaming", render: detail("summary-streaming") },
  { name: "detail.waiting-agent", render: detail("waiting-agent") },
  { name: "detail.running", render: detail("running") },
  { name: "detail.queued", render: detail("queued") },
  { name: "detail.disconnected", render: detail("disconnected") },
  { name: "detail.reconnect-failed", render: detail("reconnect-failed") },
  { name: "detail.earlier-version", render: detail("earlier-version") },
  { name: "detail.send-failed", render: detail("send-failed") },
  // 3. Panel
  { name: "panel.default", render: panel("panel-default") },
  { name: "panel.version-menu", render: panel("panel-default", true) },
  { name: "panel.streaming", render: panel("streaming") },
  { name: "panel.summary-streaming", render: panel("panel-summary-streaming") },
  { name: "panel.disconnected", render: panel("disconnected") },
  { name: "panel.reconnect-failed", render: panel("reconnect-failed") },
  { name: "panel.new-version", render: panel("panel-new-version") },
  { name: "panel.send-failed", render: panel("panel-send-failed") },
];
