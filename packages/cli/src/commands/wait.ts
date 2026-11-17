import { WAIT_MAX_MS, WaitRequest, WaitResponse } from "@prq/protocol";
import * as v from "valibot";

import type { Client } from "../client.ts";
import { CliError, EXIT, type ExitCode } from "../errors.ts";
import { backoffMs, type Clock, Retryable, waitTimeoutMs } from "../retry.ts";

// prq wait: polls /cli/wait until it answers ready or the deadline passes. A wait never takes a job, so a poll that
// was cut off loses nothing: the next one sees the same work. A 503 or a network failure starts a new poll after the
// backoff. Exit 0 ready; 2 when the deadline passes after an answered poll; 1 when it passes while the server was
// unavailable.
export async function wait(
  client: Client,
  clock: Clock,
  agentId: string,
  timeoutS: number,
  print: (result: object) => void,
): Promise<ExitCode> {
  const deadline = clock.now() + timeoutS * 1000;
  let failures = 0;
  for (;;) {
    const timeoutMs = Math.floor(Math.min(Math.max(deadline - clock.now(), 0), WAIT_MAX_MS));
    const request = v.parse(WaitRequest, { agentId, timeoutMs });
    const result = await client.attempt("/cli/wait", request, WaitResponse, waitTimeoutMs(timeoutMs));
    if (result instanceof Retryable) {
      failures += 1;
      if (failures === 1) {
        client.retrying("/cli/wait", result);
      }
      const left = deadline - clock.now();
      if (left > 0) {
        await clock.sleep(Math.min(backoffMs(failures), left));
      }
      if (clock.now() >= deadline) {
        throw new CliError(EXIT.error, `the server was unavailable until the wait's deadline (${result.reason})`);
      }
      continue;
    }
    failures = 0;
    if (result.status === "ready") {
      print({ status: "ready", next: "claim" });
      return EXIT.ok;
    }
    if (clock.now() >= deadline) {
      print({ status: "timeout", next: "wait" });
      return EXIT.timeout;
    }
  }
}
