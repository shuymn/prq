// The Worker's bindings, declared by hand as wrangler.jsonc gains them.
import type { Hub } from "./hub.ts";
import type { PrSession } from "./pr-session/index.ts";
import type { Workspace } from "./workspace.ts";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index.ts");
    }

    interface Env {
      Hub: DurableObjectNamespace<Hub>;
      PrSession: DurableObjectNamespace<PrSession>;
      // One per session, named as the session: its container and checkout.
      Workspace: DurableObjectNamespace<Workspace>;
      // Secrets, provisioned outside the repository and checked by config.ts.
      // The Access team's origin, https://<team>.cloudflareaccess.com.
      ACCESS_TEAM_DOMAIN: string;
      // The protected Access application's AUD tag.
      ACCESS_AUD: string;
      // The GitHub App's webhook secret.
      WEBHOOK_SECRET: string;
      // The host's numeric GitHub user ID: only pull requests the host authored are taken in.
      HOST_GITHUB_ID: string;
      // The cloud agent's model: the first four all or none (none: no cloud agent), the effort optional.
      // The root of an OpenAI-compatible API, https://<host>/<path>.
      MODEL_BASE_URL?: string;
      MODEL_API_KEY?: string;
      // The model's ID at the provider.
      MODEL_ID?: string;
      // The model's context window in tokens, at least 16,384.
      MODEL_CONTEXT_TOKENS?: string;
      // The reasoning effort sent with each request, in the provider's words; optional (unset: the provider's default).
      MODEL_REASONING_EFFORT?: string;
      // The GitHub App's API access, both or none (none: no head reconciliation and no cloud workspace).
      // The App's numeric ID.
      GITHUB_APP_ID?: string;
      // The App's private key, PKCS#8 PEM.
      GITHUB_APP_PRIVATE_KEY?: string;
    }
  }

  interface Env extends Cloudflare.Env {}
}
