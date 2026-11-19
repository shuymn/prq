// The app's one connection to the Hub (plan §1.5): its view (HubView, the Agent state), how many times its socket
// opened, the server's version from its prq:version message, and whether the socket has gone without an open for
// RECONNECT_FAILED_MS (§1.8), after a close or from the first connect. PartySocket reconnects it; the list does not wait
// for it.

import { HUB_NAME, HubView, ServerVersionMessage } from "@prq/protocol";
import { useAgent } from "agents/react";
import { useContext, useEffect, useRef, useState } from "react";
import * as v from "valibot";

import { reconnectBound, SocketContext } from "./session.ts";

export type Hub = { view: HubView | null; opens: number; serverVersion: string | null; unavailable: boolean };

// A message of the Hub's socket that carries the server's version.
const VersionEvent = v.pipe(v.string(), v.parseJson(), ServerVersionMessage);

export function useHub(): Hub {
  const [hub, setHub] = useState<Hub>({ view: null, opens: 0, serverVersion: null, unavailable: false });
  const open = useRef(false);
  // While the app shows the Hub: a close that its ending makes arms nothing.
  const active = useRef(false);
  // Without an open since the first connect or a close, the pool's status becomes unavailable after the bound.
  const [bound] = useState(() => reconnectBound(() => setHub((current) => ({ ...current, unavailable: true }))));
  useEffect(() => {
    active.current = true;
    if (!open.current) {
      bound.arm();
    }
    return () => {
      active.current = false;
      bound.cancel();
    };
  }, [bound]);
  const socket = useContext(SocketContext);
  useAgent<HubView>({
    agent: "hub",
    name: HUB_NAME,
    ...socket,
    onOpen: () => {
      open.current = true;
      bound.cancel();
      setHub((current) => ({ ...current, opens: current.opens + 1, unavailable: false }));
    },
    onClose: () => {
      open.current = false;
      if (active.current) {
        bound.arm();
      }
    },
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
