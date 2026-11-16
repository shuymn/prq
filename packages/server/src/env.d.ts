// The Worker's bindings, declared by hand as wrangler.jsonc gains them.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index.ts");
  }

  interface Env {
    // Secrets, provisioned outside the repository and checked by config.ts.
    // The Access team's origin, https://<team>.cloudflareaccess.com.
    ACCESS_TEAM_DOMAIN: string;
    // The protected Access application's AUD tag.
    ACCESS_AUD: string;
  }
}

interface Env extends Cloudflare.Env {}
