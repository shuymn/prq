// The Worker's bindings, declared by hand as wrangler.jsonc gains them.
import type { Hub } from "./hub.ts";
import type { PrSession } from "./pr-session/index.ts";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index.ts");
    }

    interface Env {
      Hub: DurableObjectNamespace<Hub>;
      PrSession: DurableObjectNamespace<PrSession>;
      // Secrets, provisioned outside the repository and checked by config.ts.
      // The Access team's origin, https://<team>.cloudflareaccess.com.
      ACCESS_TEAM_DOMAIN: string;
      // The protected Access application's AUD tag.
      ACCESS_AUD: string;
    }
  }

  interface Env extends Cloudflare.Env {}
}
