// The PR list's container (plan §1.5): the filters (a view preference in storage), the ledger's rows and the
// repositories, read through the page's fetch, and the Hub's view, which the list does not wait for.

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import * as v from "valibot";

import { ALL_REPOSITORIES } from "../components/RepoFilter.tsx";
import type { Hub } from "../hub.ts";
import { type ListFilter, useLedger } from "../ledger.ts";
import { useFetch } from "../reads.ts";
import { useRepos } from "../repos.ts";
import { listBody, repositoryName } from "./list-model.ts";
import { PrList } from "./PrList.tsx";

// The filter as stored: each part that is missing or not what it should be reads as the default's.
const Preferences = v.object({
  state: v.fallback(v.picklist(["open", "all"]), "open"),
  repo: v.fallback(v.nullable(v.string()), null),
  attention: v.fallback(v.boolean(), false),
});
type Preferences = v.InferOutput<typeof Preferences>;

const PREFERENCES_KEY = "prq:list-filter";

function readPreferences(): Preferences {
  let stored: unknown = null;
  try {
    stored = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "null");
  } catch {
    // Storage unavailable or unreadable: the default filter.
  }
  const parsed = v.safeParse(Preferences, stored);
  return parsed.success ? parsed.output : { state: "open", repo: null, attention: false };
}

function writePreferences(preferences: Preferences): void {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Storage unavailable: the filter lasts as long as the page.
  }
}

export function PrListScreen({ hub, notice }: { hub: Hub; notice?: ReactNode }) {
  const fetcher = useFetch();
  const [preferences, setPreferences] = useState(readPreferences);
  const choose = (change: Partial<Preferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...change };
      writePreferences(next);
      return next;
    });
  };
  const needsAttention = hub.view?.needsAttention ?? 0;
  // The filter applies while something needs attention (or the Hub's view has yet to say).
  const attention = preferences.attention && (hub.view === null || needsAttention > 0);
  const filter = useMemo(
    (): ListFilter =>
      attention ? { attention: true } : { attention: false, state: preferences.state, repo: preferences.repo },
    [attention, preferences.state, preferences.repo],
  );

  const [snapshot, reader] = useLedger(fetcher, filter, hub);
  const owners = hub.view?.owners;
  const label = useCallback((fullName: string) => repositoryName(fullName, owners), [owners]);
  const [repoItems, readRepos] = useRepos(fetcher, label);
  const refreshFailed = snapshot.failure === "refresh";
  const loadMore = useCallback(() => reader.loadMore(), [reader]);

  useEffect(() => {
    document.title = "Pull requests · prq";
  }, []);

  return (
    <PrList
      notice={notice}
      body={listBody(snapshot, owners)}
      refreshFailed={refreshFailed}
      needsAttention={needsAttention}
      attention={attention}
      state={preferences.state}
      repoLabel={preferences.repo === null ? ALL_REPOSITORIES : repositoryName(preferences.repo, owners)}
      repo={preferences.repo}
      repoItems={repoItems}
      onAttention={() => choose({ attention: !attention })}
      onState={(state) => choose({ state, attention: false })}
      onRepoOpen={readRepos}
      onRepo={(repo) => choose({ repo, attention: false })}
      onRepoRetry={readRepos}
      onRetry={() => reader.refresh()}
      onLoadMore={loadMore}
    />
  );
}
