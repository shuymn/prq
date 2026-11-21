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
    // The reasoning effort, sent as each request's `reasoning_effort` in the provider's own words (DeepSeek: low,
    // high, max). Optional: unset or empty, the request carries none and the provider's default applies.
    MODEL_REASONING_EFFORT: v.pipe(
      v.optional(v.string("is not a string")),
      v.transform((value) => (value === "" ? undefined : value)),
    ),
  },
  "is missing",
);

// The model's variables that may each be left out while the group is configured.
export const OPTIONAL_SECRET_NAMES: readonly string[] = ["MODEL_REASONING_EFFORT"];

// The variables whose absence leaves the model out.
const MODEL_VARS = Object.keys(modelSchema.entries).filter((name) => !OPTIONAL_SECRET_NAMES.includes(name));

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

// Whether a group that may be left out is: none of its variables set, or all of them empty (as a local runtime's
// overrides leave them).
function absent(env: object, names: readonly string[]): boolean {
  const values = names.map((name) => Reflect.get(env, name));
  return values.every((value) => value === undefined) || values.every((value) => value === "");
}

// What the cloud agent's model needs. Unlike the first groups it may be left out: then the cloud agent is not
// configured (null); with some set, or some empty and others unset, or any malformed, it is misconfigured.
export function readModelConfig(env: object): ConfigResult<ModelConfig> | null {
  return absent(env, MODEL_VARS) ? null : readModelGroup(env);
}

// A private key in PEM as WebCrypto imports it: PKCS#8. GitHub issues PKCS#1 (BEGIN RSA PRIVATE KEY), which the
// Worker's runtime cannot read.
function isPkcs8Pem(value: string): boolean {
  return value.includes("-----BEGIN PRIVATE KEY-----") && value.includes("-----END PRIVATE KEY-----");
}

const githubAppSchema = v.object(
  {
    // The GitHub App's numeric ID.
    GITHUB_APP_ID: v.pipe(
      v.string("is not a string"),
      v.regex(/^[1-9][0-9]*$/, "is not a numeric GitHub App ID"),
      v.transform(Number),
    ),
    // The App's private key in PKCS#8 PEM (docs/design.md, Authentication boundary).
    GITHUB_APP_PRIVATE_KEY: v.pipe(
      v.string("is not a string"),
      v.check(isPkcs8Pem, "is not a PKCS#8 private key (convert GitHub's key with openssl pkcs8 -topk8)"),
    ),
  },
  "is missing",
);

const GITHUB_APP_VARS = Object.keys(githubAppSchema.entries);

// The eleven secrets, by group in the order above, one of them optional (OPTIONAL_SECRET_NAMES).
export const SECRET_NAMES: readonly string[] = [accessSchema, webhookSchema, modelSchema, githubAppSchema].flatMap(
  (schema) => Object.keys(schema.entries),
);

export type GithubAppConfig = v.InferOutput<typeof githubAppSchema>;

const readGithubAppGroup = configReader(githubAppSchema);

// What the GitHub App's API calls need (installation tokens, head reconciliation). It may be left out as the model's
// group may: not configured (null), or misconfigured when only partly set or malformed.
export function readGithubAppConfig(env: object): ConfigResult<GithubAppConfig> | null {
  return absent(env, GITHUB_APP_VARS) ? null : readGithubAppGroup(env);
}
