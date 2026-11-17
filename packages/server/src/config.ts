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

// The smallest model window accepted: below it the system prompt, the tool definitions and one cut tool result leave no
// room for a conversation, and every turn would compact.
export const MIN_CONTEXT_TOKENS = 16_384;

const modelSchema = v.object(
  {
    // The root of an OpenAI-compatible API (https://<host>/<path>), which chat completions are requested under.
    MODEL_BASE_URL: v.pipe(
      v.string("is not a string"),
      v.check((value) => URL.parse(value)?.protocol === "https:", "is not an https URL"),
    ),
    MODEL_API_KEY: v.pipe(v.string("is not a string"), v.nonEmpty("is empty")),
    // The model, as the provider names it; it also goes into each cloud result's author.
    MODEL_ID: v.pipe(v.string("is not a string"), v.nonEmpty("is empty")),
    // The model's context window in tokens: providers do not report it reliably.
    MODEL_CONTEXT_TOKENS: v.pipe(
      v.string("is not a string"),
      v.regex(/^[1-9][0-9]*$/, "is not a whole number of tokens"),
      v.transform(Number),
      v.minValue(MIN_CONTEXT_TOKENS, "is below 16,384"),
    ),
  },
  "is missing",
);

const MODEL_VARS = ["MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_ID", "MODEL_CONTEXT_TOKENS"] as const;

export type ModelConfig = v.InferOutput<typeof modelSchema>;

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

const readModelGroup = configReader(modelSchema);

// What the cloud agent's model needs. Unlike the other groups it may be left out: with none of its variables set, or
// all four empty (as a local runtime's overrides leave them), the cloud agent is not configured (null); with some set,
// or some empty and others unset, or any malformed, it is misconfigured.
export function readModelConfig(env: object): ConfigResult<ModelConfig> | null {
  const values = MODEL_VARS.map((name) => Reflect.get(env, name));
  const absent = values.every((value) => value === undefined) || values.every((value) => value === "");
  return absent ? null : readModelGroup(env);
}
