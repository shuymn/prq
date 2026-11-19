// The UI's reads of the Worker's API (docs/design.md; plan §1.5): JSON validated with the protocol's schemas. A
// status other than 200 or a body the schema refuses is a failed read, never an empty one. The fetch is the page's,
// or the one a test gives (FetchContext).

import { createContext, useContext } from "react";
import * as v from "valibot";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export const FetchContext = createContext<Fetch>((input, init) => fetch(input, init));

export function useFetch(): Fetch {
  return useContext(FetchContext);
}

// A read that failed: the request, its status or its body. An abort is not one: it rejects with the abort's reason.
class ReadFailed extends Error {
  override name = "ReadFailed";
}

export async function readJson<S extends v.GenericSchema>(
  fetcher: Fetch,
  url: string,
  schema: S,
  signal: AbortSignal,
): Promise<v.InferOutput<S>> {
  let response: Response;
  let body: unknown;
  try {
    response = await fetcher(url, { credentials: "same-origin", signal });
    body = await response.json();
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason;
    }
    throw new ReadFailed(`${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new ReadFailed(`${url}: ${response.status}`);
  }
  const parsed = v.safeParse(schema, body);
  if (!parsed.success) {
    throw new ReadFailed(`${url}: the body is not what the protocol says`);
  }
  return parsed.output;
}
