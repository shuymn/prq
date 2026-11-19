// The PR detail's container (plan §1.6–§1.10): the session over its socket and history reads, this page's question,
// the picked version and the draft, and what the app's live regions announce.

import type { PrRef } from "@prq/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { announce } from "../announce.ts";
import { DOWN_REASONS } from "../components/Composer.tsx";
import { FAILURES } from "../components/Message.tsx";
import type { Hub } from "../hub.ts";
import type { Layout } from "../layout.ts";
import { useSession } from "../session.ts";
import { failureOf, useUnsent } from "../slots.ts";
import { detailModel } from "./detail-model.ts";
import { PrDetail } from "./PrDetail.tsx";

const reload = () => location.reload();

export function PrDetailScreen({
  prRef,
  hub,
  layout,
  notice,
}: {
  prRef: PrRef;
  hub: Hub;
  layout: Layout;
  // The build notice, given the session socket's server version too.
  notice: (sessionVersion: string | null) => ReactNode;
}) {
  const { session, slot, send, retry, discard, read } = useSession(prRef);
  const unsent = useUnsent();
  const [picked, setPicked] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const model = detailModel({ session, slot, hub: hub.view, picked });
  const title = model.header?.title;

  useEffect(() => {
    document.title = title === undefined ? "Pull request · prq" : `${title} · prq`;
  }, [title]);

  // A drop of the connection, its failure, and a send a read decided against are announced at once, as the composer
  // and the question say them.
  const down = model.composer.down;
  useEffect(() => {
    if (down !== null) {
      announce(DOWN_REASONS[down], "assertive");
    }
  }, [down]);
  const failure = failureOf(slot);
  useEffect(() => {
    if (failure !== null) {
      announce(FAILURES[failure], "assertive");
    }
  }, [failure]);

  // An answer whose job was running and is now done.
  const running = useRef(new Set<string>());
  const jobs = session.view?.jobs;
  useEffect(() => {
    const answers = (jobs ?? []).filter((job) => job.target.kind === "answer");
    if (answers.some((job) => job.state === "done" && running.current.has(job.jobId))) {
      announce("Answer complete", "polite");
    }
    running.current = new Set(
      answers.filter((job) => job.state === "claimed" || job.state === "running").map((job) => job.jobId),
    );
  }, [jobs]);

  return (
    <PrDetail
      layout={layout}
      model={model}
      notice={notice(session.serverVersion)}
      unsent={unsent}
      draft={draft}
      fieldRef={field}
      actions={{
        onDraft: setDraft,
        onSend: (text) => {
          if (send(text)) {
            setDraft("");
          }
        },
        onPick: setPicked,
        onRetrySend: retry,
        onDiscard: () => {
          discard();
          field.current?.focus();
        },
        onReadAgain: read,
        onReload: reload,
      }}
    />
  );
}
