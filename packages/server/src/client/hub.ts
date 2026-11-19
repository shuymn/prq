// The app's one connection to the Hub (plan §1.5): its view (HubView, the Agent state), how many times its socket
// opened, and the server's version from its prq:version message. PartySocket reconnects it; the list does not wait
// for it.

import { HUB_NAME, HubView, ServerVersionMessage } from "@prq/protocol";
import { useAgent } from "agents/react";
import { useState } from "react";
import * as v from "valibot";

export type Hub = { view: HubView | null; opens: number; serverVersion: string | null };

// A message of the Hub's socket that carries the server's version.
const VersionEvent = v.pipe(v.string(), v.parseJson(), ServerVersionMessage);

export function useHub(): Hub {
  const [hub, setHub] = useState<Hub>({ view: null, opens: 0, serverVersion: null });
  useAgent<HubView>({
    agent: "hub",
    name: HUB_NAME,
    onOpen: () => setHub((current) => ({ ...current, opens: current.opens + 1 })),
    // A view the protocol refuses is not shown.
    onStateUpdate: (state) => {
      const view = v.safeParse(HubView, state);
      if (view.success) {
        setHub((current) => ({ ...current, view: view.output }));
      }
    },
    onMessage: (event: MessageEvent) => {
      const message = v.safeParse(VersionEvent, event.data);
      if (message.success) {
        setHub((current) => ({ ...current, serverVersion: message.output.version }));
      }
    },
  });
  return hub;
}
