// The repositories for the list's menu (plan §1.5): GET /api/repos paged to the end on each opening of the menu. A
// newer opening, or the list leaving, aborts the read in flight and discards what it brings.

import { RepoPage, type RepoRow } from "@prq/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RepoItems } from "./components/RepoFilter.tsx";
import { type Fetch, readJson } from "./reads.ts";

async function readRepos(fetcher: Fetch, signal: AbortSignal): Promise<RepoRow[]> {
  const rows: RepoRow[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? "" : `?${new URLSearchParams({ cursor }).toString()}`;
    const page = await readJson(fetcher, `/api/repos${query}`, RepoPage, signal);
    rows.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return rows;
}

// The menu's items, read again by read(); `label` names a repository as the list does.
export function useRepos(fetcher: Fetch, label: (fullName: string) => string): [RepoItems, () => void] {
  const [items, setItems] = useState<RepoItems>({ state: "loading" });
  const controller = useRef<AbortController | null>(null);
  const read = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setItems({ state: "loading" });
    readRepos(fetcher, current.signal).then(
      (rows) => {
        if (controller.current === current) {
          setItems({
            state: "ready",
            repos: rows.map(({ fullName }) => ({ value: fullName, label: label(fullName) })),
          });
        }
      },
      () => {
        if (controller.current === current) {
          setItems({ state: "failed" });
        }
      },
    );
  }, [fetcher, label]);
  useEffect(() => () => controller.current?.abort(), []);
  return [items, read];
}
