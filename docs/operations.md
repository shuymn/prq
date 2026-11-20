# Operations

How to host prq: what it needs, how to set up the accounts and the private files its deployment reads, how to release,
deploy and check it, how to install `prq` from a release, how to recover from a deploy that stopped part-way, and how
to rotate each credential.

Every command runs from the root of a clone of this repository. `<host>` is the hostname prq is served at,
`<team>` the Zero Trust team name, `<account-id>` the Cloudflare account's ID, and `vX.Y.Z` a release's version.

## What a host needs

- A Cloudflare account holding a zone you already use (prq is served at a subdomain of it), on the Workers Paid plan,
  with Cloudflare Zero Trust on its Free plan.
- The GitHub account that opens the pull requests, and a private GitHub App owned by it, installable only on that
  account.
- An API key at a model provider with an OpenAI-compatible chat completions API, with prepaid credit or a spend limit.
  The setup below uses DeepSeek.
- A machine with this repository's tools (`mise.toml`) and Docker: wrangler builds the workspace container's image
  with the local Docker.

### Costs

From Cloudflare's pricing pages as of 2026-11-19. The allowances are per account, shared with any other Workers,
Durable Objects and containers on it; usage beyond them is billed at the listed rates.

| Item                          | Included                                                                   | Beyond                                               |
| ----------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| Workers Paid                  | $5/month minimum: 10M requests, 30M CPU-ms; static asset requests are free | per Cloudflare's rates                               |
| Durable Objects               | 1M requests, 400,000 GB-s of duration (128 MB per active object)           | per Cloudflare's rates                               |
| Containers                    | 25 GiB-h memory, 375 vCPU-min (active CPU only), 200 GB-h disk             | $0.0000025/GiB-s, $0.000020/vCPU-s, $0.00000007/GB-s |
| Workers Logs, from 2026-12-01 | 50 GB ingestion, 10 GB-month storage                                       | $0.25/GB, $0.10/GB-month                             |
| Zero Trust Free               | up to 50 users                                                             | —                                                    |
| The model                     | —                                                                          | per token, capped by the key's credit or spend limit |

- One `prq wait` held around the clock keeps the Hub active: about 0.125 GB × 2,592,000 s ≈ 324,000 GB-s a month of
  the 400,000. A hibernating WebSocket is not billed for duration; whether the web UI's connections hibernate is not
  measured yet.
- A workspace container (`basic`: 1/4 vCPU, 1 GiB memory, 4 GB disk) bills memory and disk for every second it runs,
  including the 30 minutes without a request after which it stops. The 25 GiB-h therefore cover at most 50 runs that
  are idle tail only; real runs cover fewer, and each further tail costs about $0.005 plus its active CPU.
- The model's per-token price is the cost that grows with use. The Worker logs each cloud job's tokens
  (`prq.job.usage`, [design.md](design.md#observability)).

### What stays out of the repository

The hostname, the account ID, the Access team domain and application audience, the service token, the App's private
key and webhook secret, and the model's key. They live in the private deploy directory below and in the environment of
the shells that run `prq`. Nothing in this repository names them.

## Setup on a fresh account

Setting prq up has two roles. The **publisher** owns the repository the releases come from: its settings, the release
rehearsal and the release tags ([First deploy](#first-deploy), step 1). The **host** owns a Cloudflare account, a
hostname, a GitHub App and a model key, and deploys a published release from a plain clone. One person can be both.

```sh
pnpm --dir packages/server run setup
```

runs the host's steps in order: `directory` (step 2), `cloudflare` (steps 3 to 5), `github-app` (step 6), `model`
(step 7) and `check` (step 8); `setup <step>` runs one. Each step first reads what is already done, then
prints what it did, `skipped (<reason>)`, or `done`, so running `setup` again after a stop or a change redoes only what
is missing. A step that stops stops the steps that need it, which print `skipped (it needs <step>, which stopped)`; the
others still run. The publisher's steps, `setup repository` and `setup rehearsal`, run only when named. `setup` asks on
the terminal, so it refuses an environment marked as CI, and it refuses a terminal holding an override, as the deploy
does ([The deploy command](#the-deploy-command)). It exits 0 when every step it ran passed, 1 when one refused or wrote
nothing, and 2 when a write's effect is not known.

The steps marked **[zone]** change settings of the chosen zone.

### 1. Tools

In a fresh clone:

```sh
mise trust
mise install
pnpm install --frozen-lockfile
```

After pulling changes that touch `pnpm-lock.yaml`, run `pnpm install --frozen-lockfile` again before using a new
command.

### 2. The private deploy directory

The deployment's values are read from `~/.config/prq/deploy`, readable by you alone. `setup directory` creates it
(mode `0700`) when it is missing, then checks it and each file in it: none may be a symbolic link, have a group or other
permission bit set, or carry an access control list, which can let others read what the mode does not (`chmod -N
<path>` removes one on macOS, `setfacl -b <path>` on Linux).

- `worker.env`: the Worker's nine scalar secrets as `NAME=value` lines: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
  `WEBHOOK_SECRET`, `HOST_GITHUB_ID`, `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_ID`, `MODEL_CONTEXT_TOKENS` and
  `GITHUB_APP_ID`.
- `github-app.pk8.pem`: the GitHub App's private key in PKCS#8, the Worker's `GITHUB_APP_PRIVATE_KEY`.
- `target.env`: `PRQ_HOST=<host>` and `CLOUDFLARE_ACCOUNT_ID=<account-id>`.
- `access.env`: the service token prq's CLI uses, `PRQ_URL=https://<host>`, `PRQ_ACCESS_CLIENT_ID` and
  `PRQ_ACCESS_CLIENT_SECRET`, for the AI sessions that run `prq` (README, Running a local agent) and the deploy's idle
  check. It is not a Worker secret. Its values are written unquoted and hold no space, quote or shell metacharacter, so
  `set -a; . ~/.config/prq/deploy/access.env; set +a` loads it into a shell.

The files are read as Node's `util.parseEnv` reads them: a value may be quoted, and a line starting with `#` is a
comment. Each of the steps below names the lines it adds. A setup step sets its names and keeps the file's other lines.
It refuses a file that sets a name twice, holds a value spanning lines, or has a line that is neither `NAME=value`, a
comment nor empty, and writes each value unquoted on one line. A name already set to another value is replaced only on
`y` to `Replace <NAME> in <file>? [y/N]`, which shows neither value; `n` stops the step, and the steps that need it,
before anything is written. The file is written whole to a new `0600` file beside it, renamed over it, and read back.
A value the setup asks for is typed at a prompt that does not echo; Ctrl-C there stops the setup and restores the
terminal.

### 3. Zone and hostname [zone]

```sh
pnpm --dir packages/server run setup cloudflare
```

does steps 3 to 5. It reads before it writes: the zone's settings before its one zone write, and the Zero Trust
organization and every Access application, login method, service token and policy before any Access write. Every
create is read back, and a refusal names what it found, or the token permission a denied read needed. In `setup`'s run
of every step, the step is `done` without asking anything once `target.env`, `worker.env`'s `ACCESS_TEAM_DOMAIN` and
`ACCESS_AUD`, and `access.env` are recorded; `setup cloudflare` on its own checks them all against the account again,
with a new token.

1. **wrangler's login.** When wrangler is not logged in, it runs `wrangler login`: allow its access in the browser it
   opens. The deploys use this login, not the token below.
2. **The account**: `target.env`'s, else the only one the login reaches, else the one you pick from the numbered list.
3. **The zone and the hostname**: the zone `target.env`'s `PRQ_HOST` is in; else the only zone the login lists, the
   one you pick, or (when the login's grant does not list zones) the one you type; then `Hostname label [prq]:`. The
   web UI is `https://<host>`, the CLI's `PRQ_URL` is `https://<host>`, and GitHub delivers to
   `https://<host>/webhook`. It writes `CLOUDFLARE_ACCOUNT_ID` and `PRQ_HOST` to `target.env`.
4. **The API token.** It prints the permissions to give a custom token at
   [API Tokens](https://dash.cloudflare.com/profile/api-tokens), with its account resources only that account and its
   zone resources only that zone, and asks `Cloudflare API token (not shown):`:

   | Resources | Permissions                                                                                                                                                                                    |
   | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Account   | Access: Organizations, Identity Providers, and Groups (Edit); Access: Apps and Policies (Edit); Access: Service Tokens (Edit); Account Settings (Read); Billing (Read); Workers Scripts (Read) |
   | Zone      | Zone (Read); DNS (Read); Zone Settings (Read); Bot Management (Read); Page Rules (Read); Config Rules (Edit)                                                                                   |

   The token must be active and read the zone. It stays in the setup's process alone, in no argument, file, other
   program's environment or line printed, and is kept nowhere: delete it when the step ends, as its last line says. A
   later run asks for a new one.

5. **The zone's checks**, each refusing with what to change:
   - **Bot Fight Mode** is zone-wide on the Free plan and challenges both `prq` and GitHub's webhook deliveries. If the
     zone needs it for other services, choose another zone, turn it off for the whole zone, or move the zone to Pro and
     use Super Bot Fight Mode with a skip rule for the hostname.
   - **A DNS record** on the hostname: a Worker's custom domain cannot take a hostname that has a CNAME. A record is
     accepted only when it is the Worker `prq`'s custom domain (a run after the deploy).
   - **HTML rewrites**: Rocket Loader, Email Address Obfuscation and Web Analytics injection change the web UI's page,
     which its Content-Security-Policy then refuses. When the zone's settings, a Web Analytics site on the zone, an
     active Page Rule that may match the hostname or a Configuration Rule not limited to another hostname could turn one on, it adds
     the Configuration Rule `prq-no-rewrites` (`http.host eq "<host>"`, Rocket Loader and Email Obfuscation off, RUM
     disabled) last among the zone's Configuration Rules, one rule added or updated, the others left as they are. A rule
     `prq-no-rewrites` for another hostname is refused, and so is a later rule that would turn a rewrite on again.

### 4. Cloudflare account

- **Workers Paid**: when the account's subscriptions show none, it prints the account's Workers plans page, where you
  add a billing profile and subscribe, and asks `Subscribed to Workers Paid? [y/N]`, then reads them again. When they
  still show no plan by that name, it lists the plans they show and asks whether one of them is Workers Paid.
- Keep Docker running when deploying.

### 5. Zero Trust and Access [zone]

1. **The Zero Trust organization**: when the account has none, it prints the Zero Trust dashboard, where you choose a
   team name, the Free plan and its payment step, and asks `Is the Zero Trust organization made? [y/N]`. It writes
   `ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com` to `worker.env`.
2. **Strict service token authentication**, on for organizations created from 2026-10-05: on an older organization
   where it is off, it says that turning it on applies to every Access application on the account (a request with
   service token headers is let in only by a _Service Auth_ policy, so an integration whose service token an _Allow_
   policy lets in loses access, and a bad token is refused instead of sent to sign-in) and asks; `y` changes that one
   setting alone. `n` stops the step: first-deploy's edge check
   E2 cannot pass on that account.
3. **Conflicts**: it refuses an Access application other than prq's two that covers the hostname at any path, one named
   "prq" or "prq webhook" that is not self-hosted at exactly prq's destination, and one on the Worker `prq` or on every
   Worker (Worker-level Access answers WebSocket upgrades 403, which breaks the web UI).
4. **One-time PIN**: when the account has no one-time PIN login method, it adds one; when applications (prq's own
   among them) allow every login method, and would therefore offer it too, it names them and asks first.
5. **The service token `prq-cli`**, valid for a year: created, and its Client ID and Client Secret, which Access shows
   once, written to `access.env` at once. A token whose secret `access.env` does not hold (a lost answer, a failed
   write, another client ID) is rotated only on `y` to `Rotate prq-cli's secret?`; the new secret stays unconfirmed in
   the setup's state until first-deploy's edge check passes with it. A token that is disabled or expires within 30
   days is refused, naming what to do in the dashboard.
6. **The policies and applications**, reusable policies: `prq owner` (_Allow_, your email address, asked once; a
   `prq owner` the account already has is used only after it shows whom that policy lets in and you answer `y`, which
   the setup's state records for later runs),
   `prq-cli` (_Service Auth_, the token) and `prq webhook` (_Bypass_, everyone); the application **"prq"**
   (self-hosted, `<host>`, session duration 24 hours, the policies `prq owner` then `prq-cli`, the one-time PIN its
   only login method) and **"prq webhook"** (`<host>/webhook`, the policy `prq webhook`). The more specific path wins,
   so GitHub reaches `/webhook` without Access, and the Worker checks each delivery's signature. One that exists and
   differs from this is refused, naming the field; the step changes none it finds. It writes "prq"'s audience tag as
   `ACCESS_AUD` to `worker.env`.

### 6. GitHub App

```sh
pnpm --dir packages/server run setup github-app
```

It makes a new App for prq's deployment on the account `gh` is logged in as, which must be the account that opens the
pull requests; an App you use elsewhere, such as for local checks, stays as it is. It needs `PRQ_HOST` and asks for the
hostname when `target.env` lacks it.

1. It opens a page on `127.0.0.1` that sends GitHub the App's manifest: the name `<login>-prq` (`<login>-prq-2` and on
   when GitHub has an App of that name; a long login is cut to fit GitHub's 34 characters), the description `prq's
   deployment (registration <nonce>)` with a random nonce, the homepage `https://<host>`, the webhook URL
   `https://<host>/webhook` with **Active** unchecked, Repository permissions Contents, Pull requests and Issues, each
   read-only (Metadata read-only comes with them), the Pull request event, and installable only on this account. The
   name and the nonce are recorded in `~/.local/state/prq/setup.json` before the browser opens. On GitHub's page, keep
   the proposed name and click **Create GitHub App**, within 55 minutes of the page's making (GitHub gives the whole
   flow an hour, the code's exchange included).
2. GitHub redirects back to the page on `127.0.0.1`. When the browser cannot reach it (it runs on another machine),
   paste the URL from the browser's address bar at the prompt, which does not echo it. Either way the redirect must
   carry the random state the page sent, and its code is exchanged within the hour for the App's ID, its private key
   and its webhook secret. The step writes, as one set, the key converted to the PKCS#8 the Worker reads
   ([design.md](design.md#authentication-boundary)) to `github-app.pk8.pem`, and `GITHUB_APP_ID`, `WEBHOOK_SECRET` (the
   App's own from GitHub, else 32 random bytes in hex) and `HOST_GITHUB_ID` (the `gh` account's ID) to `worker.env`.
   The App's OAuth client secret is not kept, and nothing printed holds the code, the state, the key or a secret. When
   `worker.env` already sets `GITHUB_APP_ID` or `WEBHOOK_SECRET`, or the key file exists, the step asks `The new App
   replaces … Go on? [y/N]` before the browser opens: the new App's set replaces them whole.
3. It opens the App's installation page: install it on the repositories you open pull requests in and on one small
   private test repository. It waits up to 30 minutes for the installation on your account, asks for the test
   repository (`owner/name`), checks that the App is installed on it and that it is private, and records it in
   `setup.json`.
4. It reads the App back: the four read permissions and nothing else, the Pull request event (or none yet), the owner
   `HOST_GITHUB_ID` names, and the webhook URL `https://<host>/webhook` (or none yet).

On a re-run, the recorded App (`GITHUB_APP_ID`, a `WEBHOOK_SECRET` that is not empty, and the key file) is checked with
GitHub (its key must make a token GitHub takes for that ID), then the installation and the read-back again. A
registration that did not finish is settled before another starts:

- When the App of the recorded name carries the recorded nonce in its description, GitHub made it but its key did not
  reach the deploy directory: the step prints its settings page, asks you to delete it there (**Delete GitHub App**, at
  the bottom), checks that it is gone and starts over.
- Otherwise setup cannot tell which App, if any, the registration made (the name was changed on GitHub, or the code's
  exchange was lost), and it never names another App for deletion: it asks you to delete, in
  <https://github.com/settings/apps>, any App whose description holds `registration <nonce>`, and starts over only on
  `y` to `Is no App with that description left? [y/N]`.

A key and an ID that do not belong together otherwise stop the step.

**An App made by hand** (when GitHub refuses the redirect to `127.0.0.1`, or for a second key): create it as above on
<https://github.com/settings/apps/new> (homepage `https://<host>`, webhook URL `https://<host>/webhook` with **Active**
unchecked, the three read permissions, installable only on this account), generate a private key in its settings, then

```sh
pnpm --dir packages/server run setup github-app --key <downloaded>.pem --app-id <the App's ID>
```

converts the download into `github-app.pk8.pem`, checks it with GitHub for that ID, and refuses, writing nothing, an App
whose owner is not the account `gh` is logged in as. It records that account's ID as `HOST_GITHUB_ID`, keeps a
`WEBHOOK_SECRET` already set (else generates one: the App's own is set from it when the webhook is turned on), asks
before deleting the download, and goes on with the installation and the read-back as above.

**Turning the webhook on**, once the Worker serves `https://<host>`: in one save of the App's webhook settings, set the
URL `https://<host>/webhook`, the secret from `worker.env`, SSL verification on, and Active. On macOS,
`sed -n 's/^WEBHOOK_SECRET=//p' ~/.config/prq/deploy/worker.env | pbcopy` copies the secret without showing it. Then,
under Permissions & events, select the **Pull request** event if it is not, and save: an App created with its webhook
inactive may subscribe to events only once it is active. A `ping` answered 200 does not show the subscription, since
the Worker answers other events `ignored`. A pull request opened before the subscription has no delivery in the App's
Recent deliveries and is never taken in: open a new one.

### 7. The model

```sh
pnpm --dir packages/server run setup model
```

With no model in `worker.env`, it prints DeepSeek's API keys page, where you create a key for prq's deployment alone,
with prepaid credit or a spend limit; a key used for local checks stays separate, so either can be revoked alone (two
keys drawing on one account balance still share it). It asks `DeepSeek API key (not shown):`, checks the key with
DeepSeek's models list (`GET https://api.deepseek.com/models`), which must take it and list `deepseek-flash`, and adds
to `worker.env`:

```
MODEL_BASE_URL=https://api.deepseek.com
MODEL_API_KEY=<the key>
MODEL_ID=deepseek-flash
MODEL_CONTEXT_TOKENS=1048576
```

The models list shows that the key and the model work, not that the key has credit: the first completed analysis
does. With a model in `worker.env`, the step sends the stored key only when `MODEL_BASE_URL` is
`https://api.deepseek.com`: it checks the key and the stored `MODEL_ID` the same way and adds a missing line, keeping
the `MODEL_ID` and `MODEL_CONTEXT_TOKENS` set. When DeepSeek refuses the stored key, it asks for a new one, then whether
to replace it. Another `MODEL_BASE_URL` is skipped (the step checks nothing), and a key without a `MODEL_BASE_URL` is
refused, sent nowhere.

The window is prq's own budget for every cloud session: it keeps 16,384 tokens for the answer and compacts a
conversation once it would exceed 1,032,192; it is not sent to the provider. Another OpenAI-compatible provider takes
its own base URL, model ID and window (at least 16,384 tokens), added to `worker.env` by hand.

### 8. Check the files

```sh
pnpm --dir packages/server run setup check
```

It runs `secrets check`'s checks, then checks the directory and each file in it as `setup directory` does (modes,
symbolic links and access control lists), that no file sets a name twice or a value spanning lines, that `target.env`
sets exactly `CLOUDFLARE_ACCOUNT_ID` and `PRQ_HOST` as the deploy reads them (an account ID and a hostname), and that
`access.env` sets exactly `PRQ_URL` (`https://` and `PRQ_HOST`), `PRQ_ACCESS_CLIENT_ID` and `PRQ_ACCESS_CLIENT_SECRET`,
the last two not empty. It makes no network call.

`secrets check` reads `worker.env` and `github-app.pk8.pem` and makes no network call. It refuses the directory or a
file when it is a symbolic link or has a group or other permission bit set (it reads the mode, not an access control
list), a missing or empty secret, a name the Worker does not read, a value the Worker's own checks
(`packages/server/src/config.ts`) would refuse, and a key that cannot make an RS256 signature that verifies with its
public half. Its messages name a file or a variable, never a value, nor the name the Worker does not read, which could
be a value pasted in the wrong place.

## The secrets command

`pnpm --dir packages/server run secrets <command>` puts the deploy directory's secrets on the Worker `prq` through the
repository's pinned wrangler, logged in as above, on the account `target.env` names:

- `check`: as in [Check the files](#8-check-the-files).
- `status`: the account (its ID, and its name as the login sees it) and the Worker, then which of the ten secrets the
  Worker has, which it lacks, and which it has besides. Names only: whether a value works shows when the Worker uses
  it.
- `put`: `check`, then the account, the Worker, the names it sends and the Worker's other secrets, which stay as they
  are; it asks `Put the secrets? [y/N]` and, on `y`, sends the ten as one JSON object on wrangler's stdin
  (`wrangler secret bulk`). That deploys a new version of the live Worker with the new values. Before asking, `put`
  refuses when the account has no Worker `prq`. That is a check before the write, not part of it: wrangler creates an
  empty Worker of the name when the write finds none, so do not delete the Worker while `put` runs.

`put` exits 0 when wrangler acknowledged the write. It exits 1 when that `put` changed no secret: it refused before
sending (a failed check, no `y`, a Worker it cannot read), or Cloudflare refused the write because the Worker's latest
version is not deployed. It exits 2 when the write went out without an acknowledgement: Cloudflare returned another
error, wrangler failed otherwise (a lost response among the causes), or it did not finish within five minutes. A signal
that stops `put` while wrangler sends says the same. The live secret update is then unconfirmed: the Worker holds either
the new secrets or the ones it had, and `status`, which shows names, cannot tell which. Retry the intended set until
`put` exits 0, or restore the saved set and put it until `put` exits 0. A retry that exits 1 changes nothing, so the
update stays unconfirmed until one exits 0.

`status` and `put` refuse when `packages/server/wrangler.jsonc` sets an `account_id` other than `target.env`'s, which
wrangler would use in its place, and, before that, a terminal holding an override, as the deploy does
([The deploy command](#the-deploy-command)). Each wrangler call uses the configuration's top level, no `.env` file, and
Cloudflare's production API.

Nothing it prints holds a value. `put` shows none of the output of `wrangler secret bulk`, the call that gets the
values, since an error from Cloudflare's API can quote what was sent. When a call before it fails (`whoami` or the
secret list, which `status` and `put` both make), the output of that call is shown, with each value `put` read
replaced; it then concerns the login, the account or the Worker. wrangler gets the values on stdin only and runs with
its log sanitizing on, so its debug log leaves out the request that carries them; the bulk call writes no log file, so
an error it logs does not reach the disk either.

To remove a secret the Worker no longer reads:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm --dir packages/server exec wrangler secret delete <NAME>
```

## Releases

Every deploy is a release, `vX.Y.Z`; what a release is and what the release check checks are in
[design.md](design.md#versions). The steps:

1. A release pull request, `chore(release): vX.Y.Z`, changes only the two versions. While the version is 0.x, a change
   to the protocol that `prq` must follow raises the minor version, anything else the patch.
2. Once it is merged, check its merge commit `<sha>` (the full SHA) before tagging it, with `gh` logged in:

   ```sh
   git fetch origin
   pnpm --dir packages/server run release-check -- vX.Y.Z --pre-tag <sha>
   ```

3. Check that release immutability is still on, with `gh` logged in as the repository's admin, since GitHub fixes only
   the releases published while it is on. It must print `true`; anything else stops here until the
   repository's release settings are applied again ([First deploy](#first-deploy), step 1):

   ```sh
   gh api repos/{owner}/{repo}/immutable-releases --jq .enabled
   ```

   Then tag the commit, annotated, and push the tag. A pushed tag is there for good, so a mistaken one costs its
   version, and the release takes the next:

   ```sh
   git tag -a vX.Y.Z -m vX.Y.Z <sha>
   git push origin vX.Y.Z
   ```

4. The tag runs the release workflow (`.github/workflows/release.yml`, Actions → Release), which publishes `prq` for
   each platform as [design.md](design.md#local-cli-prq) describes; follow it through its Publish job. It needs the
   repository's release settings ([First deploy](#first-deploy), step 1). Its Verify job prints the draft release's ID
   (`Created the draft release <id>`).

   A failed job is rerun with "Re-run failed jobs" on the same run, which keeps its draft; a Publish job that failed
   after publishing finds the release published on its rerun and finishes without publishing again. To start over
   instead, delete the draft by its ID, then "Re-run all jobs": Verify refuses a tag that already has a release, a
   draft included.

   ```sh
   gh api --method DELETE repos/{owner}/{repo}/releases/<id>
   ```

## The deploy command

`pnpm --dir packages/server run deploy -- <arguments>` deploys the Worker `prq` to the account and hostname
`target.env` names, through wrangler logged in as in [Cloudflare account](#4-cloudflare-account). It never uploads the
checkout it runs in. Run it from a terminal of your own: the bootstrap and a release refuse, before any call, where the
environment marks the run as CI by a variable wrangler reads as such (`CI` unless it is `false`, `BUILD_ID`,
`BUILD_NUMBER`, `CI_APP_ID`, `CI_BUILD_ID`, `CI_BUILD_NUMBER`, `CI_NAME`, `CONTINUOUS_INTEGRATION`, `RUN_ID`, or a CI
service's own, such as `GITHUB_ACTIONS`), and names the variables it found, since wrangler then answers its own
questions with their defaults.

Every mode, `--read-back` included, also refuses a terminal that holds an override, before any call or credential, and
names the variables it found: unset them, or open a new terminal. An override is one of the tests' own settings
(`PRQ_DEPLOY_*`), or a variable the pinned wrangler reads that would send it to another account, Worker, API or login,
or with other credentials than its login: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_KEY`,
`CLOUDFLARE_EMAIL` (and the older `CF_*` names of these four and of `CLOUDFLARE_API_BASE_URL`), `CLOUDFLARE_AUTH_PROFILE`,
`CLOUDFLARE_ENV`, `CLOUDFLARE_API_BASE_URL`, `CLOUDFLARE_COMPLIANCE_REGION`, `CLOUDFLARE_API_HEADERS`,
`CLOUDFLARE_CONTAINER_REGISTRY`, `CLOUDFLARE_CLIENT_ID`, `WRANGLER_CI_*` (`WRANGLER_CI_OVERRIDE_NAME` names another
Worker), and the OAuth login's `WRANGLER_AUTH_DOMAIN`, `WRANGLER_AUTH_URL`, `WRANGLER_TOKEN_URL`, `WRANGLER_REVOKE_URL`,
`WRANGLER_CLIENT_ID`, `WRANGLER_API_ENVIRONMENT` and `WRANGLER_CF_AUTHORIZATION_TOKEN`. wrangler then runs with an
environment built for it, so a variable this list misses does not reach it either: the paths, user and shell, the temp
directory, the locale and the terminal, `XDG_*` (where its login is kept), and Docker's settings (`DOCKER_*`,
`WRANGLER_DOCKER_BIN`, `WRANGLER_DOCKER_HOST`). Each call is given an env file that holds nothing, in place of the `.env`
and `.env.local` wrangler would load from its working directory. A release's install, build and upload do not run
through mise: mise only names the clone's pinned Node and pnpm (`mise which`), which the deploy then runs directly, so
nothing mise's configuration sets (an `[env]`, global or a project's, or a `MISE_ENV` variant's) reaches them.

- `--bootstrap`: once, before prq's first upload. It deploys an inert Worker named `prq` (every request answers 404
  with an `x-prq-bootstrap` header; no assets, Durable Objects or container) with workers.dev and preview URLs off and
  the version tag `prq-bootstrap`, so that no upload of prq is ever reachable at those addresses. It refuses while the
  Worker `prq` has a live version. It prints the version's ID, asks for the account's workers.dev subdomain as the
  dashboard shows it (Workers & Pages, `<subdomain>.workers.dev`) or `none`, and records both. `--bootstrap --resume`
  deploys the same Worker again over a live version tagged `prq-bootstrap` alone.
- `vX.Y.Z`: a release, in a terminal (it refuses otherwise: wrangler asks there before it replaces a DNS record or
  another Worker's domain on the hostname). In order, it
  1. clones the tag from `origin` into a new directory of the OS temp directory, `prq-deploy-vX.Y.Z-…`, which it prints
     and keeps, running no git hook (neither yours nor a template's);
  2. runs, in the clone, the release check, `mise trust`, `mise install` (the tag's pinned tools), `mise which` for the
     pinned Node and pnpm, then that pnpm's `install --frozen-lockfile` and the web UI's build, each stopped after an
     hour, without `PRQ_BUILD_VERSION` and `PRQ_BUILD_PREFIX` (the browser check's build inputs), with those tools first
     on `PATH`. Before the build, and again right before the upload, it
     refuses when the clone's `HEAD` or a tracked file is no longer the commit the release check checked;
  3. refuses when the tag's tracked files hold the value of `PRQ_HOST`, `CLOUDFLARE_ACCOUNT_ID`, `ACCESS_TEAM_DOMAIN`
     (its hostname) or `ACCESS_AUD`, naming the variable and the file, never the value, or when its `wrangler.jsonc`
     would turn workers.dev or preview URLs on or configures a route (the hostname comes from `target.env` alone);
  4. reads what is live, and refuses when the Worker has no live version (the bootstrap comes first), or when its
     workers.dev address or preview URLs are on or cannot be read (finish the bootstrap first). wrangler has no command
     that reads these two, so the deploy reads them as wrangler's deploy does, from Cloudflare's API with wrangler's
     own login (`wrangler auth token --json`, asked again for the reads after the upload, since a login can expire
     during a long deploy), and the container applications the same way; the credentials stay in its process, in no
     argument, file or line printed;
  5. prints the account, the live versions, the hostname with those two settings, the tag and its commit, the container
     application and what the deploy does to it, and asks `Deploy vX.Y.Z to <host>? [y/N]`;
  6. checks that no cloud work waits or runs: it reads every page of the ledger at `https://<host>/api/ledger` with the
     service token of `PRQ_ACCESS_CLIENT_ID` and `PRQ_ACCESS_CLIENT_SECRET`, from the shell when it sets both, else from
     `access.env`, and refuses
     while a pull request the cloud agent owns has a job waiting or running, or when the ledger cannot be read. The check
     is skipped while the live Worker is still the bootstrap's (versions whose bindings wrangler lists, none but
     secrets), which serves nothing at the hostname; a version whose bindings are not listed counts as a release;
  7. has the clone's wrangler deploy it, with `<host>` as the Worker's custom domain, the tag as the version's tag and
     `prq vX.Y.Z <sha>` as its message, its output shown, stopped after two hours. wrangler builds the workspace
     container's image with the local Docker first, then uploads the Worker, which makes the new version live, then
     pushes the image and updates the container application, and then sets workers.dev, preview URLs and the custom
     domain;
  8. reads what is live again, then the read-back below.

  `--immediate` has the Durable Objects take the new code at once rather than within wrangler's deferred window (up to
  5 minutes). `--keep-image` deploys without building or rolling out the container's image, and refuses before the
  container application exists. `--ignore-running` turns a busy or unreadable ledger into a warning.

- `--read-back <record>`: a release's read-back again, on the account and container application its record names.

The deploy refuses, before any wrangler call, when `packages/server/wrangler.jsonc` here sets an `account_id` other than
`target.env`'s, and a release also refuses, before its upload, a tag whose `wrangler.jsonc` sets one at all: wrangler
would use it in place of `target.env`'s. As for the secrets command, each wrangler call uses its configuration's top
level and Cloudflare's production API, as the deploy's own reads of that API do.

A signal or a bound stops wrangler with the processes it started, found by their parent links when it acts: a process
that left that tree and ignores SIGTERM can outlive the deploy (`ps` shows it).

**The record.** Every run keeps one in `~/.local/state/prq/deploys` (`$XDG_STATE_HOME/prq/deploys` when that is set),
readable by you alone: the bootstrap's as `bootstrap/<time>.json`, a release's as `<time>-vX.Y.Z/record.json` beside
wrangler's output file. A release's record holds the tag, its commit, the account, the hostname and the clone; the live
versions (ID, tag, share of traffic), the Worker's workers.dev and preview URLs, and the container application
`prq-workspace` (ID, version, image, active rollout) before the upload and after it; the idle check's result; the
upload's exit and the version it made; and the read-back. It is written as each is known, the upload's result before
anything after it is read, so a failed or stopped upload leaves one too.

**The read-back.** The version the deploy made must be live alone, with workers.dev and preview URLs off. Then, by what
the deploy did to the container application:

- _created_ (the first release): wrangler creates the application directly, with no rollout to follow, and Cloudflare
  provisions a new application over several minutes, in which its containers can fail to start. The command asks you to
  answer `y` once the dashboard (Workers & Pages → Containers → `prq-workspace`) shows it ready, or `n`, which records
  the provisioning unverified.
- _changed_ (a new image): it reads the application and every page of its instances every 10 seconds until the
  application, still with the image and version read right after the upload, has no active rollout, and every active
  instance reports that version (one with no version does not), none provisioning or failed. A Durable Object with no
  instance is listed as inactive and counted apart. It stops reading 30 minutes after it began; a read under way then
  finishes first, within wrangler's wait of 5 minutes.
- _unchanged_, or _kept_ with `--keep-image`: complete once the version is live, unless a read found the application
  with an active rollout (as before a retry whose image was the same): after the upload, in a `--read-back`, or before
  the upload with the same version and image. That rollout, with the image and version it was found with, is then read
  as a changed one is, also once it has cleared.

Once found, the rollout to follow is recorded (`rollout`: the application, its image and version) right after the read
that found it, before anything else is decided: also when that read missed something else (the live versions, the
Worker's settings) or found an upload that did not finish, each of which leaves the read-back incomplete. Every later
`--read-back` follows it, and still completes only with the deployed version live alone and both settings off.

It exits 0 once the read-back is complete. When the upload failed it exits with wrangler's code, 1 when it was stopped
at its bound. Otherwise it exits 2 with `verification incomplete`, the reason, and the command that resumes it,
`pnpm --dir packages/server run deploy -- --read-back <record>`; Ctrl-C during the read-back ends it the same way. It
also prints what to read in the dashboard (Workers & Pages → `prq` → Settings → Domains & Routes).

**The quiet interval.** A new Worker version can run with the previous image while the new one is pushed and rolled out,
and a running container keeps the previous image until it is replaced. One host avoids that by deploying when nothing
happens: no new pushes to its pull requests and no questions from the idle check until the read-back is complete. The
idle check is a snapshot of a ledger that can lag its sessions; keeping the interval is yours.

## The deployed checks

`pnpm --dir <checkout>/packages/cli run check:deployed -- <mode>`, below `check:deployed <mode>`, checks the deployment
itself. Run it from a checkout of the deployed tag with its dependencies installed and its web UI built (the clone a
release prints has both), so that the `prq` it builds, the build it compares the served files with, and the version it
expects are the tag's. Every mode but `endpoints` reads `PRQ_URL`, `PRQ_ACCESS_CLIENT_ID` and
`PRQ_ACCESS_CLIENT_SECRET` from the shell, as `prq` does. `summary` also needs `gh` signed in with read access to the
private test repository. The build `edge` runs and `gh` get only the variables they use (the paths, locale and
terminal, XDG's, `gh`'s own settings and login, the tool managers', a proxy's less any bypass entry naming the hostname
or the team domain), none of the deployment's, and the build's output is not kept. The steps of
[First deploy](#first-deploy), [Each release](#each-release), [Recovery](#recovery) and [Rotation](#rotation) say when
to run each mode.

| Mode                                                                 | Model tokens |
| -------------------------------------------------------------------- | ------------ |
| `endpoints <subdomain> [--version <id>]`, or `endpoints none`        | no           |
| `edge --team-domain https://<team>.cloudflareaccess.com [--pr <pr>]` | no           |
| `pool`                                                               | no           |
| `summary <owner>/<repo>`                                             | yes          |
| `ask <pr> "<question>"`                                              | yes          |
| `jobs <pr>`                                                          | no           |
| `retry <pr> <jobId>`                                                 | no           |

`<pr>` is `<owner>/<repo>#<number>`. Each mode prints one line per assertion: `pass`; `FAIL`; `unattributed`, a denial
that did not come from the Worker but that the command cannot credit to Access (find it in Zero Trust's Access logs by
the time and `cf-ray` the line gives); or `unexercised`, when the event the assertion needs did not happen, which is
not a pass. It exits 1 when an assertion failed, and 130 when stopped with Ctrl-C, which ends what it started, the
build's whole process group included. `--json <file>` saves the run to a new file readable by you alone. What a line
says of an answer is the check's own words over the fields it reads: the status, a header reduced to what the verdict
needs (a media type the web UI or the API uses, a version, the sign-in path or `/`), job and message IDs in the form the
Worker and the web UI give them, the edge check's own agents, a failure's category, an error's code, sizes and times.
Anything else in those fields shows as a fixed label (another media type, ID or agent), and no header value, body,
`gh` or build output, or the full text of a job's failure (the web UI shows it) is copied, so no line or saved run holds
the hostname, the team domain, the application's AUD, the workers.dev subdomain or the token.

- **`endpoints`** asks the Worker's workers.dev addresses, `https://prq.<subdomain>.workers.dev/` and, with
  `--version`, the version's preview URL. It fails an answer that holds anything of prq (the bootstrap's header, a
  `Prq-Version`, an error of the Worker's, the web UI), passes Cloudflare's page for an address with nothing behind it,
  and leaves any other answer, or none, unexercised. `<subdomain>` is the account's workers.dev subdomain as the
  dashboard shows it. The dashboard's Domains & Routes for `prq` (workers.dev and Preview URLs disabled) are the
  evidence for an unexercised address, and on their own with `endpoints none`, when the subdomain is not known. After a
  deploy, run it without `--version`: a Worker with Durable Objects has no version URLs. It needs no credentials and
  builds nothing, so any checkout serves.
- **`edge`** checks the hostname through Access. Without credentials, every path and the WebSockets must be redirected
  (302) to the team's sign-in for the hostname (E1). The known Client ID with a wrong secret must be refused 401 or 403,
  and a random Client ID refused, neither reaching the Worker (E2). That refusal is Access's strict mode for presented
  tokens, which is on for every Zero Trust organization created from 2026-10-05 and may need turning on in an older one:
  without it Access sends such a request to the sign-in, and E2 fails saying so. `POST /webhook` without a signature
  must get the Worker's signature refusal, and `/webhook/x` the Worker's own 401 (E3). With the service token, the
  ledger (E4); two raw `/cli/wait` polls that end near 25 seconds with the tag's `Prq-Version`, and
  `prq wait --timeout 40`, which times out with no version notice (E5); `prq wait` with a wrong secret, which ends at
  once with exit 3 (E6); the web UI's files, each byte for byte with the headers of the tag's build, a conditional
  reload, `/index.html` and a missing asset (E7); the Hub's WebSocket with its version (E8); and a poll left to its
  deadline against one the client leaves, which the Hub must stop counting as waiting within 5 seconds (E9). E9 credits
  the departure only when no byte of an answer to the left poll had come before the client left, and the poll left to
  its deadline passed. It takes about a minute, and leaves the agents `edge-poll`, `edge-cli`, and the run's own
  `edge-keep-<id>` and `edge-cut-<id>`, in the pool for 10 minutes. `--pr` adds that pull request's WebSocket to E1 and
  E2. A browser's way through Access, by its cookie, is not among them ([First deploy](#first-deploy) checks it).
- **`pool`** waits until no local agent is present, naming the ones left each minute: stop every `prq wait` first. An
  agent stays present 10 minutes after its last contact, one holding a job up to 70; the wait ends after 75 minutes.
- **`summary`** waits for an empty pool, notes the repository's pull requests, and asks you to open a new one. It takes
  the first new pull request that reaches the ledger, requires the cloud agent to own it (open another once the pool is
  empty if a local agent does), and passes once the analysis job of GitHub's head (`gh pr view`) has stored its complete
  result, written by the cloud agent with the model and the tokens in its metadata; a failed analysis fails it with its
  reason's category and the `retry` command. No new pull request within 30 minutes, while the App's Recent deliveries
  show no event for it, means the Pull request event was not subscribed when it was opened. The Worker's logs then show
  `prq.workspace.prepared` and `prq.job.usage` for the job.
- **`ask`** asks the question over the pull request's WebSocket as the web UI does, and passes once the answer job's
  complete result names the question and was written at the commit the question was asked at: the head of the latest
  completed analysis, else the pull request's head. The request's acknowledgement is not the answer. When that commit
  moves while the question waits (an analysis completes), the commit the answer should be at is not decided, and the
  assertion is unexercised: ask again once the pull request is quiet.
- **`jobs`** lists a pull request's jobs with their state and revision; **`retry`** retries a claimed or failed one
  from the revision it lists, as the web UI's Retry does. `retry` only puts the job back in line: follow it with
  `jobs <pr>` until the job is done.

## First deploy

Once [Setup on a fresh account](#setup-on-a-fresh-account) is done and `setup check` passes:

1. **Protect the release tags and set up releases.** These are the publisher's steps, for the repository the
   releases come from; a host deploying a published release from a plain clone skips them. They run only when named
   (`setup` without a step runs neither), on a terminal, from a checkout of the current `main` (`git switch main`, then
   `git pull`), with `gh` 2.87.0 or later (it names the run a dispatch started) logged in as the repository's admin. A
   fine-grained token needs Administration write and Issues write (or Pull requests write, for the labels
   `.github/infra.yaml` declares) for `setup repository`, and Administration read, Actions write,
   Checks read and Contents write for `setup rehearsal`; a call GitHub denies names the permission it takes.

   ```sh
   pnpm --dir packages/server run setup repository
   pnpm --dir packages/server run setup rehearsal
   ```

   `setup repository` fetches origin's `main` and refuses unless `HEAD` is that commit and `.github/infra.yaml` on disk
   is byte for byte main's (an edit git status does not show included) and declares origin's repository. It runs
   `mise exec -- gh-infra plan --detailed-exitcode .github/infra.yaml`; when the plan shows changes, it runs
   `gh-infra apply` in the foreground, which shows its plan and asks its own confirmation (it is never given
   `--auto-approve`, and a declined apply exits 0), then the plan again, which must show none. Then it reads back,
   each printed as `pass`: `release-tag-creation` and `release-tag-immutability`, both `active` on `refs/tags/v*`
   alone, the first with the creation rule and the admin role as its only bypass, the second with the update and
   deletion rules and no bypass (`.github/infra.yaml` declares its bypass empty, so the apply removes one; a bypass
   `gh`'s login cannot read is refused, not taken as none); `actions/attest@*` among the allowed actions; and
   immutable releases enabled. Anything else is refused, naming the field. It exits 2 when the apply failed or did not
   finish: what it changed is not known, and running the step again plans from what GitHub has.

   `setup rehearsal` reads the same settings back, asks `Dispatch the release rehearsal on main (<sha>)? [y/N]`, and
   runs `gh workflow run release.yml --ref main`. The rehearsal builds and checks all three platforms' archives as a
   release does, under the tag name `rehearsal-<run-id>`, which is never pushed, publishes nothing, and deletes its
   draft at the end. The dispatch names the branch, so the step fetches `main` again after the answer and dispatches
   nothing if it moved. It records the dispatch in `~/.local/state/prq/setup.json` (`$XDG_STATE_HOME/prq` when that is
   set) before sending it, then the run from the URL `gh` prints for it, and follows the run, refusing one that is not
   `.github/workflows/release.yml` dispatched on `main`. A run on another commit than the one confirmed is no rehearsal
   of `main`: its drafts are offered for deletion, then it is recorded as failed. It prints each job's conclusion as it
   ends, then the run's, a `pass` or `fail` line for each Smoke job, the Read probe and Discard, and the Read probe's
   notice, which says whether `contents: read` alone reads the draft (Smoke keeps `contents: write` until a rehearsal
   shows that it does); a notice it cannot read is reported as such. The rehearsal passes once the run and each of those
   jobs concluded success. Last, it lists the drafts tagged with the run's ID and asks `Delete the draft <id>? [y/N]`
   for each one left (Discard did not run, had no ID or failed). Only once none is left is the outcome recorded, with
   the commit it was rehearsed on; until then the run stays recorded, and the next run of the step follows it again and
   lists its drafts before anything else. Run again, the step resolves what it recorded before dispatching: a run under
   way (after a stop, or past the follow's hour) is followed; a dispatch whose run `gh` did not name (exit 2) is looked
   for among the release workflow's dispatched runs at that commit since, each offered with `Follow run <id>, created
   <time>? [y/N]`, and only when none is taken does it ask to dispatch again. Once a rehearsal of the current `main`
   passed, it prints `done`; a passed one of an older commit is named, and the current `main` is rehearsed. A rehearsal
   that failed is run again as a new dispatch, by running the step again, not with "Re-run failed jobs": its draft is
   already deleted.

2. **The first release**, `v0.1.0`, as in [Releases](#releases): the release pull request, the check with `--pre-tag`,
   the tag, and the release workflow it runs, which publishes `prq` `v0.1.0`.
3. **The bootstrap**: `pnpm --dir packages/server run deploy -- --bootstrap`. Then, in the dashboard's Domains & Routes
   for `prq`: workers.dev and Preview URLs disabled, no custom domain. It prints, on a line of its own, the check that
   the two addresses answer nothing of prq, `check:deployed endpoints <subdomain> --version <id>` with the subdomain you
   gave and the version it made, or `endpoints none`, which leaves the dashboard as the evidence: run it.

   If the bootstrap stopped part-way and running it again is refused because the Worker has a live version tagged
   `prq-bootstrap`, run `pnpm --dir packages/server run deploy -- --bootstrap --resume`: it deploys the same Worker over
   that version, so its settings apply, and records it. `--resume` works only until the next step, whose versions carry
   no tag. A release refuses while workers.dev or preview URLs are on, so a stopped bootstrap is finished here, or the
   two turned off in the dashboard.

4. **The secrets**: `pnpm --dir packages/server run secrets put` until it exits 0
   ([The secrets command](#the-secrets-command)), then `secrets status`, which lists all ten and nothing besides.
5. **The deploy**, in a terminal with Docker running: `pnpm --dir packages/server run deploy -- v0.1.0`. Before
   answering `y`, check the account, the hostname, and that the applications "prq" and "prq webhook" cover it
   ([Zero Trust and Access](#5-zero-trust-and-access-zone)). The idle check is skipped, since nothing is served at the
   hostname yet. The container application is created: answer `y` once the dashboard shows `prq-workspace` ready. If
   the dashboard does not show it, answer `n` and wait the provisioning time Cloudflare documents before going on; the
   record then says the provisioning is unverified, and `--read-back <record>` lets you answer again later.
6. **What is served**: the dashboard's Domains & Routes for `prq` shows `<host>` as its custom domain, with workers.dev
   and Preview URLs still disabled; signing in at `https://<host>` with the one-time PIN shows the web UI with
   `v0.1.0`, and the browser's developer tools show the Hub's WebSocket open, its `prq:version` message naming
   `v0.1.0`: the cookie's way through Access, which `edge` does not check. Then run the two commands the deploy printed,
   each on a line of its own and run in the clone it kept, `check:deployed edge --team-domain "$ACCESS_TEAM_DOMAIN"`
   and `check:deployed endpoints "$WORKERS_SUBDOMAIN"`, with `PRQ_URL` and the service token in the shell,
   `ACCESS_TEAM_DOMAIN` set to `https://<team>.cloudflareaccess.com` and `WORKERS_SUBDOMAIN` to the account's
   workers.dev subdomain (the deploy prints neither).
7. **The webhook**: turn it on as in [GitHub App](#6-github-app), in one save, then the Pull request event.
8. **The first pull request**: stop every `prq wait`, and run `check:deployed pool` until it passes (an agent stays in
   the pool 10 minutes after its last contact), so the cloud agent owns the next new pull request. Then
   `check:deployed summary <owner>/<repo>` with the private test repository: open a new pull request there when it
   asks. It passes once the analysis is stored; the logs ([Rotation](#rotation) says where) show it prepare the
   workspace (`prq.workspace.prepared`) and finish (`prq.job.usage` with the outcome `done`). A pull request opened
   before the Pull request event was subscribed has no delivery in the App's Recent deliveries: open a new one. An
   analysis that failed while the container application was still provisioning is retried with
   `check:deployed retry <pr> <jobId>` once the dashboard shows the application ready. `retry` only puts the job back
   in line: follow it with `check:deployed jobs <pr>` until the job is done, then, for `summary`'s verdict, run
   `summary` again with a new pull request once the pool is empty.
9. **A question**: `check:deployed ask <pr> "<question>"` on that pull request, then
   `check:deployed edge --team-domain https://<team>.cloudflareaccess.com --pr <pr>`, which adds its session's
   WebSocket to E1 and E2.

## Each release

1. The release pull request, the check with `--pre-tag`, the tag and its release workflow, as in
   [Releases](#releases).
2. Pick a quiet interval: no cloud job waiting or running, and no pushes or questions until the deploy's read-back is
   complete.
3. In a terminal with Docker running: `pnpm --dir packages/server run deploy -- vX.Y.Z`. It exits 0 once the read-back is complete.
4. Sign in at `https://<host>`: the web UI shows the new version. Then run the two checks the deploy printed, as in
   [First deploy](#first-deploy) step 6.
5. Once the release workflow has published it, install the new `prq` wherever a local agent runs
   ([Installing prq](#installing-prq)). Until then a `prq` of the previous release prints the version notice
   ([design.md](design.md#versions)) and works as before.
6. Remove the clone the deploy printed once you no longer need it.

## Installing prq

Each release publishes `prq` for three platforms, as `prq-vX.Y.Z-<target>.tar.gz` holding the one file `prq`:
`darwin-arm64` (macOS on Apple silicon), `linux-x64` and `linux-arm64`. Download it with `gh` (`gh auth login` first),
and verify its provenance before extracting or running anything. `gh attestation verify` checks that the archive was
built by this repository's release workflow from the tag, whose commit the release check found on `main` with its
`Check` passed; run nothing from an archive it refuses.

macOS on Apple silicon:

```sh
gh release download vX.Y.Z -R shuymn/prq -p prq-vX.Y.Z-darwin-arm64.tar.gz &&
  gh attestation verify prq-vX.Y.Z-darwin-arm64.tar.gz -R shuymn/prq \
    --signer-workflow shuymn/prq/.github/workflows/release.yml --source-ref refs/tags/vX.Y.Z &&
  tar -xzf prq-vX.Y.Z-darwin-arm64.tar.gz prq
```

Linux on x86-64:

```sh
gh release download vX.Y.Z -R shuymn/prq -p prq-vX.Y.Z-linux-x64.tar.gz &&
  gh attestation verify prq-vX.Y.Z-linux-x64.tar.gz -R shuymn/prq \
    --signer-workflow shuymn/prq/.github/workflows/release.yml --source-ref refs/tags/vX.Y.Z &&
  tar -xzf prq-vX.Y.Z-linux-x64.tar.gz prq
```

Linux on ARM64:

```sh
gh release download vX.Y.Z -R shuymn/prq -p prq-vX.Y.Z-linux-arm64.tar.gz &&
  gh attestation verify prq-vX.Y.Z-linux-arm64.tar.gz -R shuymn/prq \
    --signer-workflow shuymn/prq/.github/workflows/release.yml --source-ref refs/tags/vX.Y.Z &&
  tar -xzf prq-vX.Y.Z-linux-arm64.tar.gz prq
```

Each block extracts `prq` only once its verification passed. Then put `prq` on the `PATH` of the shell the AI session
runs in (for example `install -m 0755 prq ~/.local/bin/prq`), check that `prq --version` prints `vX.Y.Z`, and give that
shell its environment as [README's Running a local agent](../README.md#running-a-local-agent) says.

Download with `gh` rather than a browser: macOS marks a browser's download as coming from the internet and may then
refuse to run a binary that is not notarized. The Linux archives hold Bun's glibc build, so they need a glibc-based
distribution (not a musl one such as Alpine). Each release's runners have run its archives on their own platform;
whether your machine runs them shows on the first install.

mise can install the same archive as a convenience, `mise use -g github:shuymn/prq@X.Y.Z`, but it is not the provenance
check: it verifies an attestation when the release has one and installs an archive that has none. The commands above
are the provenance check.

## Recovery

The Worker's logs are where [Rotation](#rotation) says.

### What is live

`pnpm --dir packages/server run deploy -- --read-back <record>` reads the live versions, the Worker's workers.dev and
preview URLs and the container application on the record's account, records them and reads back what the record
lacks. By hand, with the record's account:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm --dir packages/server exec wrangler deployments status --name prq
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm --dir packages/server exec wrangler containers info <application-id>
```

The application's ID is in the record, or listed by `wrangler containers list`. The hostname, workers.dev and preview
URLs are in the dashboard's Domains & Routes for `prq`.

### A deploy that stopped part-way

wrangler builds the image with the local Docker before the upload, so a failed build leaves nothing new live. After it
uploads the Worker, which makes the new version live, it pushes the image and updates the container application, and
then sets workers.dev, preview URLs and the custom domain, so a failure there can leave the new version live with the
previous image, or with the previous settings and custom domain. The command then exits with wrangler's code and prints
what is live, which the record holds too.

- **The upload failed or was stopped after the new version went live**: stay in the quiet interval and run
  `deploy -- vX.Y.Z` again with the same tag. It clones, builds and uploads the tag again, wrangler building the image
  anew, and its read-back shows the version and the application's rollout; the dashboard's Domains & Routes show the
  settings and the custom domain.
- **The first release stopped part-way**: the new version is live, but the hostname may not serve it yet, so the retry's
  idle check cannot read the ledger there. Check the dashboard's Domains & Routes for `prq`: when it shows no custom
  domain and workers.dev and Preview URLs disabled, the partial release serves nothing, and the retry may pass
  `--ignore-running`, still in the quiet interval. Once the hostname serves prq, deploy without it, so that the idle
  check runs.
- **The upload was stopped** (Ctrl-C, or its bound): the record says what is live is unread. `--read-back <record>`
  reads it, and completes the read-back when the version the upload made is live alone; otherwise it says to deploy the
  tag again. A record left at `uploading` with no result (the deploy ended with no chance to record one) is read the same
  way, with the version wrangler's output file names, which wrangler writes once its deploy is done.
- **Nothing of the new version went live**: the previous release still serves. Deploy the tag again once the cause is
  fixed.

### A read-back that stayed incomplete

The record names the reason, and `--read-back <record>` reads again. A new application counts as ready on your `y`. A
changed application's rollout counts as complete once `wrangler containers info` shows the image the deploy pushed with
no `active_rollout_id`, and every active instance that
`wrangler containers instances <application-id> --json --per-page 25` lists, through each `--page-token`, reports the
application's version, none provisioning or failed. Whether Cloudflare clears `active_rollout_id` when a rollout ends is
first seen on the first deploy that changes the image. Until then, and whenever the read-back keeps waiting for a
rollout the dashboard (Workers & Pages → Containers → `prq-workspace`) shows done, the dashboard is the evidence, and the
record stays incomplete with its reason.

### Rollback

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm --dir packages/server exec wrangler rollback <version-id> --name prq
```

moves the Worker's traffic back to an earlier version; it rolls back neither Durable Object storage nor the container's
image. Roll back only when, between the two versions, none of these changed: the schema steps
(`packages/server/src/schema.ts`), the Durable Object migrations and the bindings (`packages/server/wrangler.jsonc`),
the secrets (a version carries the secrets it was deployed with, so never across a `secrets put`), and the container's
image. Otherwise release a fix.

### Other failures

- **A failed delivery**: the App's Advanced → Recent deliveries shows each delivery with the Worker's answer and can
  redeliver it. A 401 (the signature) or a 500 (a webhook secret or host ID missing or malformed) is redelivered once
  its cause is fixed. After a 503 or a timeout the Worker may still have stored the delivery: its redelivery answers
  `received` or `duplicate`, and either is one intake.
- **A failed job** stays `failed` with its reason. Once its cause is fixed, retry it from the web UI or with
  `check:deployed retry <pr> <jobId>` from a checkout of the deployed tag, and follow it with
  `check:deployed jobs <pr>` until it is done.
- **A missing or malformed secret**: the Worker answers every protected request 500 when the Access team domain or
  audience is, and every delivery 500 when the webhook secret or the host's ID is; it logs `prq.config.invalid` naming
  the variable. `secrets status` names a missing secret: fix `worker.env`, then `secrets check` and `secrets put`.
- **The provider refuses a call** (a spend limit, a key or a model it does not accept): the job fails with
  `provider refused the request (HTTP <status>): <its message>`. Fix the credit or the key (`secrets put` for a new
  one), then retry the job.
- **Skill scripts refused** because an earlier run's processes could not be confirmed ended: the workspace runs no
  script until its container stops, 30 minutes after its last request.
- **An Access session that ended in the browser**: reload the page; Access asks for a one-time PIN again.
- **A release workflow that failed**: rerun its failed jobs once the cause is fixed, as in [Releases](#releases). A
  cause that needs a change to the repository cannot be fixed under the same tag, which never moves: delete the run's
  draft by its ID and release the fix as the next version. When Publish failed because the release is not immutable,
  the release is published with its assets still replaceable: turn release immutability on
  ([First deploy](#first-deploy), step 1) before the next tag.

## Rotation

Each new credential is checked working before the old one is revoked. When `secrets put` exits 2, the Worker may hold
the new value or the old one: run it again until it exits 0 before going on (a retry that exits 1 leaves that as it
was). The Worker's logs, where the steps below look, are on the Worker's Observability page in the dashboard, or
streamed by `CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm --dir packages/server exec wrangler tail`.

### Service token

1. Rotate `prq-cli` in Zero Trust with a grace period: the Client ID stays, a new Client Secret is issued, and the old
   one keeps working until the grace period ends.
2. Set the new `PRQ_ACCESS_CLIENT_SECRET` in `access.env` and in every AI session's environment that does not load it.
3. Run `prq wait --timeout 60` there: it ends with a job (exit 0) or a timeout (exit 2). Exit 3 with an authentication
   failure means Access refused the token. With the new secret in the shell,
   `check:deployed edge --team-domain https://<team>.cloudflareaccess.com` passes E4 to E6
   ([The deployed checks](#the-deployed-checks)).
4. Let the old secret expire.

A lost secret: `setup cloudflare` rotates it without a grace period and writes `access.env`. A new token (a new Client
ID) is added to the policy `prq-cli` before any session uses it, and the old one removed after.

### The App's private key

1. Generate a new private key in the App's settings, then run `setup github-app --key <downloaded>.pem --app-id
   <the App's ID>` ([GitHub App](#6-github-app)), which asks before replacing `github-app.pk8.pem`.
2. `pnpm --dir packages/server run secrets put`.
3. With no local agent waiting, push a commit to a pull request in the private test repository that the cloud agent
   owns (a pull request keeps the owner it first got), and see its analysis prepare the workspace
   (`prq.workspace.prepared`) and finish (`prq.job.usage` with the outcome `done`).
4. Delete the old key in the App's settings.

### Webhook secret

An App has one webhook secret, so deliveries made between the Worker's change and the App's fail.

1. Keep the current file: `cp -p ~/.config/prq/deploy/worker.env ~/.config/prq/deploy/worker.env.previous` (it stays
   readable by you alone).
2. Replace the `WEBHOOK_SECRET` line in `worker.env` with a new secret (`openssl rand -hex 32`), then
   `pnpm --dir packages/server run secrets put`.
3. Once `put` exits 0, set the same secret in the App's webhook settings at once.
4. A delivery made between steps 2 and 3 failed with 401 before the Worker took it in; it shows in the App's Advanced →
   Recent deliveries and can be redelivered from there. Whether GitHub signs such a redelivery with the new secret is
   not known yet: if the redelivery fails with 401 too, push a new commit instead.
5. Once a delivery has been accepted with the new secret, delete `worker.env.previous`.

If the first `put` exits 1, it changed no secret and the Worker keeps the old one: leave the App as it is. If it exits
2, or a signal stopped it while wrangler sent, Cloudflare returned an error or no answer and the live secret update is
unconfirmed; the App's deliveries fail with 401 if the Worker holds the new secret. Keep the App setting as it is while
you retry the intended set until `put` exits 0, then go on at step 3. To stay on the old secret instead, restore the
saved set and put it until `put` exits 0:
`cp -p ~/.config/prq/deploy/worker.env.previous ~/.config/prq/deploy/worker.env`, then `secrets put` (`put` reads only
`worker.env`). A retry that exits 1 changes nothing, so the update stays unconfirmed: keep retrying, or restoring,
until `put` exits 0. Restore the same way when the App's update fails. In each case, verify an accepted delivery (200
in Recent deliveries) before deleting `worker.env.previous`.

### Model key

1. Create a new key and replace `MODEL_API_KEY` in `worker.env`.
2. `pnpm --dir packages/server run secrets put`.
3. With no local agent waiting, push a commit to the cloud agent's test pull request and see its analysis finish
   (`prq.job.usage` with the outcome `done` and the model's tokens), or have
   `check:deployed ask <pr> "<question>"` on it pass.
4. Revoke the old key at the provider.

### Access team and audience

`ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` change only when the application or the team is created again. Update
`worker.env`, run `secrets put`, then sign in to `https://<host>` from a browser and run `prq wait --timeout 60` as
above, and `check:deployed edge --team-domain https://<new-team>.cloudflareaccess.com` with the new team domain.
