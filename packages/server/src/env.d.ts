// The Worker's bindings, declared by hand as wrangler.jsonc gains them.
declare namespace Cloudflare {
  interface Env {}
}

interface Env extends Cloudflare.Env {}
