# Operations

How to host prq: what it needs, how to set up the accounts and the private files its deployment reads, and how to
rotate each credential. Deploying the Worker and releasing `prq` are not described here yet.

Every command runs from the root of a clone of this repository. `<host>` is the hostname prq is served at,
`<team>` the Zero Trust team name, and `<account-id>` the Cloudflare account's ID.

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

The deployment's values are read from `~/.config/prq/deploy`, readable by you alone. Create it before writing anything
into it, and write its files with the same umask:

```sh
umask 077
mkdir -p -m 0700 ~/.config/prq/deploy
```

- `worker.env`: the Worker's nine scalar secrets as `NAME=value` lines: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
  `WEBHOOK_SECRET`, `HOST_GITHUB_ID`, `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_ID`, `MODEL_CONTEXT_TOKENS` and
  `GITHUB_APP_ID`.
- `github-app.pk8.pem`: the GitHub App's private key in PKCS#8, the Worker's `GITHUB_APP_PRIVATE_KEY`.
- `target.env`: `PRQ_HOST=<host>` and `CLOUDFLARE_ACCOUNT_ID=<account-id>`.

The files are read as Node's `util.parseEnv` reads them: a value may be quoted, and a line starting with `#` is a
comment. Each of the steps below names the line it adds. To add a value without it showing on screen or in the shell's
history, paste it at a prompt that does not echo:

```sh
read -rs 'value?MODEL_API_KEY: ' && printf 'MODEL_API_KEY=%s\n' "$value" >> ~/.config/prq/deploy/worker.env; unset value
```

(That is zsh; in bash, `read -rsp 'MODEL_API_KEY: ' value`.)

### 3. Zone and hostname [zone]

Pick the zone before fixing the hostname, and check what it already does to traffic:

- **Bot Fight Mode** is zone-wide on the Free plan and challenges both `prq` and GitHub's webhook deliveries. If the
  zone needs it for other services, choose another zone, turn it off for the whole zone, or move the zone to Pro and
  use Super Bot Fight Mode with a skip rule for the hostname.
- **Access**: an Access policy set on a Worker named `prq` (Worker-level Access answers WebSocket upgrades 403, which
  breaks the web UI), and any wildcard Access application that would cover the hostname.
- **An existing DNS record** on the hostname: a Worker's custom domain cannot take a hostname that has a CNAME.
- **HTML rewrites**: Rocket Loader, Email Address Obfuscation and Web Analytics injection change the web UI's page,
  which its Content-Security-Policy then refuses. Where the zone uses them, turn them off for the hostname with a
  Configuration Rule.

Then fix `<host>` and add `PRQ_HOST=<host>` to `target.env`. The web UI is `https://<host>`, the CLI's `PRQ_URL` is
`https://<host>`, and GitHub delivers to `https://<host>/webhook`.

### 4. Cloudflare account

1. Add a billing profile and subscribe to **Workers Paid**.
2. Log wrangler in to the account that holds the zone: `pnpm --dir packages/server exec wrangler login`.
3. Add `CLOUDFLARE_ACCOUNT_ID=<account-id>` to `target.env`: `pnpm --dir packages/server exec wrangler whoami` lists
   the accounts the login reaches, with their IDs.
4. Keep Docker running when deploying.

### 5. Zero Trust and Access [zone]

1. **The Zero Trust organization**: choose a team name, the Free plan, and One-time PIN as the login method. Add
   `ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com` (no trailing slash) to `worker.env`.
2. **A service token** named `prq-cli`, valid for a year, with an expiry alert if the account offers one. Its Client ID
   and Client Secret are shown once: they are `PRQ_ACCESS_CLIENT_ID` and `PRQ_ACCESS_CLIENT_SECRET` in the environment
   of every AI session that runs `prq` (README, Running a local agent). They are not Worker secrets.
3. **The application "prq"**: self-hosted, hostname `<host>`, path empty; a policy _Allow_ for your email address, and a
   policy _Service Auth_ for the token `prq-cli`; session duration 24 hours; the cookie settings as they are. Add its
   audience tag as `ACCESS_AUD=<aud>` to `worker.env`.
4. **The application "prq webhook"**: hostname `<host>`, path `webhook`; one policy _Bypass_ for Everyone. The more
   specific path wins, so GitHub reaches `/webhook` without Access, and the Worker checks each delivery's signature.

### 6. GitHub App

Create the App on the account that opens the pull requests, or add a key to one you already have:

- **A new App**: a name and homepage URL; under Webhook, **Active** unchecked (the URL, the secret, Active and the
  events are set once the Worker serves the hostname, below); Repository permissions Contents, Pull requests and Issues,
  each read-only (Metadata read-only comes with them); installable "Only on this account".
- **An App you already use elsewhere** (such as for local checks): generate a second private key for prq's deployment,
  so that either key can be revoked without the other. Both keys mint tokens for the same installations, so the second
  narrows nothing.

Then, with `umask 077` in the shell:

1. Generate a private key in the App's settings, convert GitHub's PKCS#1 to the PKCS#8 the Worker reads
   ([design.md](design.md#authentication-boundary)), then delete the download:

   ```sh
   openssl pkcs8 -topk8 -nocrypt -in <downloaded>.pem -out ~/.config/prq/deploy/github-app.pk8.pem
   ```

2. Generate the webhook secret into `worker.env` (nothing is printed):

   ```sh
   printf 'WEBHOOK_SECRET=%s\n' "$(openssl rand -hex 32)" >> ~/.config/prq/deploy/worker.env
   ```

   Do not enter it, or the webhook URL, in the App yet.

3. Install the App on the repositories you open pull requests in, and on one small private test repository.
4. Add `GITHUB_APP_ID=<the App's ID>` and `HOST_GITHUB_ID=<id>` to `worker.env`, where `<id>` is what
   `gh api user --jq .id` prints when `gh` is logged in as the account that opens the pull requests.

**Turning the webhook on**, once the Worker serves `https://<host>`: in one save of the App's webhook settings, set the
URL `https://<host>/webhook`, the secret from `worker.env`, SSL verification on, and Active. On macOS,
`sed -n 's/^WEBHOOK_SECRET=//p' ~/.config/prq/deploy/worker.env | pbcopy` copies the secret without showing it. Then,
under Permissions & events, select the **Pull request** event and save: an App created with its webhook inactive
subscribes to events only once it is active. A `ping` answered 200 does not show the subscription, since the Worker
answers other events `ignored`. A pull request opened before the subscription has no delivery in the App's Recent
deliveries and is never taken in: open a new one.

### 7. The model

Create a key for prq's deployment alone, with prepaid credit or a spend limit; a key used for local checks stays
separate, so either can be revoked alone (two keys drawing on one account balance still share it). Add to `worker.env`:

```
MODEL_BASE_URL=https://api.deepseek.com
MODEL_API_KEY=<the key>
MODEL_ID=deepseek-flash
MODEL_CONTEXT_TOKENS=1048576
```

The window is prq's own budget for every cloud session: it keeps 16,384 tokens for the answer and compacts a
conversation once it would exceed 1,032,192; it is not sent to the provider. Another OpenAI-compatible provider takes
its own base URL, model ID and window (at least 16,384 tokens).

### 8. Check the files

```sh
ls -la ~/.config/prq/deploy
pnpm --dir packages/server run secrets check
```

The directory shows `drwx------` and each file `-rw-------`, with no `+` after the mode: a `+` marks an access control
list, which can let others read what the mode does not (on macOS, `ls -le` shows it and `chmod -N <path>` removes it).
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
wrangler would use in its place. Each wrangler call uses the configuration's top level, whatever `CLOUDFLARE_ENV` says,
and Cloudflare's production API, whatever `CLOUDFLARE_API_BASE_URL` or `CF_API_BASE_URL` says.

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

## Rotation

Each new credential is checked working before the old one is revoked. When `secrets put` exits 2, the Worker may hold
the new value or the old one: run it again until it exits 0 before going on (a retry that exits 1 leaves that as it
was). The Worker's logs, where the steps below look, are on the Worker's Observability page in the dashboard, or
streamed by `CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm --dir packages/server exec wrangler tail`.

### Service token

1. Rotate `prq-cli` in Zero Trust with a grace period: the Client ID stays, a new Client Secret is issued, and the old
   one keeps working until the grace period ends.
2. Set the new `PRQ_ACCESS_CLIENT_SECRET` in every AI session's environment.
3. Run `prq wait --timeout 60` there: it ends with a job (exit 0) or a timeout (exit 2). Exit 3 with an authentication
   failure means Access refused the token.
4. Let the old secret expire.

A lost secret: rotate without a grace period. A new token (a new Client ID) is added to the application's _Service
Auth_ policy before any session uses it, and the old one removed after.

### The App's private key

1. Generate a new private key in the App's settings and convert it over `github-app.pk8.pem` as in
   [GitHub App](#6-github-app).
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
   (`prq.job.usage` with the outcome `done` and the model's tokens).
4. Revoke the old key at the provider.

### Access team and audience

`ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` change only when the application or the team is created again. Update
`worker.env`, run `secrets put`, then sign in to `https://<host>` from a browser and run `prq wait --timeout 60` as
above.
