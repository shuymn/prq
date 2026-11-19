// The client's routes (plan §1.3) on the Navigation API: a same-origin navigation to a page of the UI is handled in
// the page, without loading it again; a reload, a fragment link, a download, a form and the Worker's own routes are
// left to the browser. The route follows the current history entry.

import { PrRef } from "@prq/protocol";
import { useSyncExternalStore } from "react";
import * as v from "valibot";

export type Route = { name: "list" } | { name: "detail"; ref: PrRef } | { name: "settings" } | { name: "not-found" };

const LIST = new URLPattern({ pathname: "/" });
const DETAIL = new URLPattern({ pathname: "/pr/:owner/:repo/:number" });
const SETTINGS = new URLPattern({ pathname: "/settings" });

// The Worker's routes (wrangler.jsonc `run_worker_first`), which a navigation reaches as a page load.
const WORKER_PATHS = /^\/(api|agents|cli|webhook)(\/|$)/;

// A pull request's path, its parts as PrRef takes them (any case), or not found.
function routeOf(href: string): Route {
  const url = new URL(href);
  if (LIST.test(url)) {
    return { name: "list" };
  }
  if (SETTINGS.test(url)) {
    return { name: "settings" };
  }
  const detail = DETAIL.exec(url)?.pathname.groups;
  if (detail !== undefined) {
    const number = /^[1-9][0-9]*$/.test(detail["number"] ?? "") ? Number(detail["number"]) : Number.NaN;
    const ref = v.safeParse(PrRef, { owner: detail["owner"], repo: detail["repo"], number });
    if (ref.success) {
      return { name: "detail", ref: ref.output };
    }
  }
  return { name: "not-found" };
}

function intercept(event: NavigateEvent): void {
  const destination = new URL(event.destination.url);
  if (
    !event.canIntercept ||
    event.hashChange ||
    event.downloadRequest !== null ||
    event.formData !== null ||
    event.navigationType === "reload" ||
    destination.origin !== location.origin ||
    WORKER_PATHS.test(destination.pathname)
  ) {
    return;
  }
  // The new view focuses its own heading once it renders.
  event.intercept({ focusReset: "manual" });
}

function subscribe(listener: () => void): () => void {
  navigation.addEventListener("navigate", intercept);
  navigation.addEventListener("currententrychange", listener);
  return () => {
    navigation.removeEventListener("navigate", intercept);
    navigation.removeEventListener("currententrychange", listener);
  };
}

const currentUrl = () => navigation.currentEntry?.url ?? location.href;

// The route of the current entry. One subscriber (the app) intercepts navigations.
export function useRoute(): Route {
  const href = useSyncExternalStore(subscribe, currentUrl);
  return routeOf(href);
}
