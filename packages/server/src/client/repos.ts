// The repositories for the list's menu (plan §1.5): GET /api/repos paged to the end on each opening of the menu. A
// newer opening, or the list leaving, aborts the read in flight and discards what it brings.

import { RepoPage } from "@prq/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import { type Fetch, readPages } from "./reads.ts";

// The read's repositories by their full names (owner/name), while they are read, or the read's failure. The list
// names them when it renders, with the owners it knows then.
export type RepoRead = { state: "loading" } | { state: "failed" } | { state: "ready"; fullNames: string[] };

// The menu's repositories, read again by read().
export function useRepos(fetcher: Fetch): [RepoRead, () => void] {
  const [repos, setRepos] = useState<RepoRead>({ state: "loading" });
  const controller = useRef<AbortController | null>(null);
  const read = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setRepos({ state: "loading" });
    readPages(fetcher, "/api/repos", RepoPage, current.signal).then(
      (rows) => {
        if (controller.current === current) {
          setRepos({ state: "ready", fullNames: rows.map((row) => row.fullName) });
        }
      },
      () => {
        if (controller.current === current) {
          setRepos({ state: "failed" });
        }
      },
    );
  }, [fetcher]);
  useEffect(() => () => controller.current?.abort(), []);
  return [repos, read];
}
