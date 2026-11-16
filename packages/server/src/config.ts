import * as v from "valibot";

// An origin is all an issuer and a key set URL are built from; a path or a trailing slash would make every token's
// `iss` mismatch.
function isHttpsOrigin(value: string): boolean {
  const url = URL.parse(value);
  return url?.protocol === "https:" && url.origin === value;
}

// The Worker's secrets (env.d.ts), in groups by the part that needs them. Each group is validated once per env object
// (configReader), and a request is refused only for a group it needs. Each issue names the variable and the problem,
// never the value.
const accessSchema = v.object(
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

const webhookSchema = v.object(
  {
    // The GitHub App's webhook secret, which every delivery is signed with.
    WEBHOOK_SECRET: v.pipe(v.string("is not a string"), v.nonEmpty("is empty")),
    // The host's GitHub user ID, as the `id` GitHub gives a pull request's author.
    HOST_GITHUB_ID: v.pipe(v.string("is not a string"), v.regex(/^[1-9][0-9]*$/, "is not a numeric GitHub user ID")),
  },
  "is missing",
);

type ConfigResult<T> = { ok: true; config: T } | { ok: false; issues: string[] };

// Validates env once per env object: once per isolate in production. A request that needs an invalid value is
// refused rather than served with a check left out.
function configReader<S extends v.GenericSchema>(schema: S): (env: object) => ConfigResult<v.InferOutput<S>> {
  const parsed = new WeakMap<object, ConfigResult<v.InferOutput<S>>>();
  return (env) => {
    let result = parsed.get(env);
    if (result === undefined) {
      const parse = v.safeParse(schema, env);
      result = parse.success
        ? { ok: true, config: parse.output }
        : { ok: false, issues: parse.issues.map((issue) => `${v.getDotPath(issue) ?? "env"} ${issue.message}`) };
      parsed.set(env, result);
    }
    return result;
  };
}

// What the Access check needs.
export const readAccessConfig = configReader(accessSchema);
// What the webhook needs.
export const readWebhookConfig = configReader(webhookSchema);
