import type { Hub } from "./hub.ts";
import type { PrSession } from "./pr-session/index.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      Hub: DurableObjectNamespace<Hub>;
      PrSession: DurableObjectNamespace<PrSession>;
      ACCESS_TEST_SECRET: string;
      ACCESS_AUD: string;
      ACCESS_ISS: string;
      OWNER_GITHUB_ID: string;
      WEBHOOK_SECRET: string;
      PRESENCE_TTL_MS: string;
      WAIT_MAX_MS: string;
      MOCK_CHUNK_DELAY_MS: string;
    }
  }
  type Env = Cloudflare.Env;
}
