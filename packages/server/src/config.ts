import * as v from "valibot";

// An origin is all an issuer and a key set URL are built from; a path or a trailing slash would make every token's
// `iss` mismatch.
function isHttpsOrigin(value: string): boolean {
  const url = URL.parse(value);
  return url?.protocol === "https:" && url.origin === value;
}

// The Worker's secrets (env.d.ts). Each issue names the variable and the problem, never the value.
const configSchema = v.object(
  {
    // The Access team's origin, `https://<team>.cloudflareaccess.com`: the tokens' issuer and the key set's host.
    ACCESS_TEAM_DOMAIN: v.pipe(
      v.string("is not a string"),
      v.check(isHttpsOrigin, "is not an https origin (https://<team>.cloudflareaccess.com)"),
    ),
    // The protected Access application's AUD tag. Required: jose skips the audience check when it is undefined.
    ACCESS_AUD: v.pipe(v.string("is not a string"), v.nonEmpty("is empty")),
  },
  "is missing",
);

type Config = v.InferOutput<typeof configSchema>;

type ConfigResult = { ok: true; config: Config } | { ok: false; issues: string[] };

const parsed = new WeakMap<object, ConfigResult>();

// Validates env once per env object: once per isolate in production. A request that needs an invalid value is
// refused rather than served with a check left out.
export function readConfig(env: object): ConfigResult {
  let result = parsed.get(env);
  if (result === undefined) {
    const parse = v.safeParse(configSchema, env);
    result = parse.success
      ? { ok: true, config: parse.output }
      : { ok: false, issues: parse.issues.map((issue) => `${v.getDotPath(issue) ?? "env"} ${issue.message}`) };
    parsed.set(env, result);
  }
  return result;
}
