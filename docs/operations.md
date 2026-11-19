# Operations

How to host prq: what it needs, how to set up the accounts and the private files its deployment reads, how to release
and deploy it and recover from a deploy that stopped part-way, and how to rotate each credential. Publishing `prq`'s
binaries is not described here yet.

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

3. Tag it, annotated, and push the tag. A pushed tag is there for good, so a mistaken one costs its version, and the
   release takes the next:

   ```sh
   git tag -a vX.Y.Z -m vX.Y.Z <sha>
   git push origin vX.Y.Z
   ```

## The deploy command

`pnpm --dir packages/server run deploy -- <arguments>` deploys the Worker `prq` to the account and hostname
`target.env` names, through wrangler logged in as in [Cloudflare account](#4-cloudflare-account). It never uploads the
checkout it runs in. Run it from a terminal of your own: the bootstrap and a release refuse, before any call, where the
environment marks the run as CI by a variable wrangler reads as such (`CI` unless it is `false`, `BUILD_ID`,
`BUILD_NUMBER`, `CI_APP_ID`, `CI_BUILD_ID`, `CI_BUILD_NUMBER`, `CI_NAME`, `CONTINUOUS_INTEGRATION`, `RUN_ID`, or a CI
service's own, such as `GITHUB_ACTIONS`), and names the variables it found, since wrangler then answers its own
questions with their defaults.

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
  2. runs, in the clone, the release check, `mise trust`, `mise install` (the tag's pinned tools),
     `pnpm install --frozen-lockfile` and the web UI's build, each stopped after an hour, without `PRQ_BUILD_VERSION`
     and `PRQ_BUILD_PREFIX` (the browser check's build inputs). Before the build, and again right before the upload, it
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
     service token of `PRQ_ACCESS_CLIENT_ID` and `PRQ_ACCESS_CLIENT_SECRET`, set in the shell as for `prq`, and refuses
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
level, whatever `CLOUDFLARE_ENV` says, and Cloudflare's production API, whatever `CLOUDFLARE_API_BASE_URL` or
`CF_API_BASE_URL` says, as the deploy's own reads of that API do. Its tests point those reads at a stand-in with
`PRQ_DEPLOY_API`, which the deploy refuses before anything else unless it is a loopback address beside the tests'
stand-in for wrangler.

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
- _unchanged_, or _kept_ with `--keep-image`: complete once the version is live, unless the record shows an active
  rollout (as after a retry whose image was the same), now or in an earlier read, which is then read as a changed one
  is, also once the rollout has cleared.

It exits 0 once the read-back is complete. When the upload failed it exits with wrangler's code, 1 when it was stopped
at its bound. Otherwise it exits 2 with `verification incomplete`, the reason, and the command that resumes it,
`pnpm --dir packages/server run deploy -- --read-back <record>`; Ctrl-C during the read-back ends it the same way. It
also prints what to read in the dashboard (Workers & Pages → `prq` → Settings → Domains & Routes).

**The quiet interval.** A new Worker version can run with the previous image while the new one is pushed and rolled out,
and a running container keeps the previous image until it is replaced. One host avoids that by deploying when nothing
happens: no new pushes to its pull requests and no questions from the idle check until the read-back is complete. The
idle check is a snapshot of a ledger that can lag its sessions; keeping the interval is yours.

## First deploy

Once [Setup on a fresh account](#setup-on-a-fresh-account) is done and `secrets check` passes:

1. **Protect the release tags.** Apply the repository settings, which hold the two tag rulesets, with
   `mise exec -- gh-infra plan .github/infra.yaml` and then `mise exec -- gh-infra apply .github/infra.yaml`, and read
   them back in the repository's Settings → Rules → Rulesets: `release-tag-creation` and `release-tag-immutability`
   active on `refs/tags/v*`, the first with the admin role as its only bypass, the second with none.
2. **The first release**, `v0.1.0`, as in [Releases](#releases): the release pull request, the check with `--pre-tag`,
   the tag.
3. **The bootstrap**: `pnpm --dir packages/server run deploy -- --bootstrap`. Then, in the dashboard's Domains & Routes
   for `prq`: workers.dev and Preview URLs disabled, no custom domain. Checking by request that the addresses it prints
   answer nothing of prq comes with the deployed checks.

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
   `v0.1.0`. Checking the deployment through Access by request comes with the deployed checks.
7. **The webhook**: turn it on as in [GitHub App](#6-github-app), in one save, then the Pull request event.
8. **The first pull request**: stop every `prq wait` and let 10 minutes pass (an agent stays in the pool that long after
   its last contact), so the cloud agent owns the next new pull request. Open one in the private test repository and
   see its analysis prepare the workspace (`prq.workspace.prepared`) and finish (`prq.job.usage` with the outcome
   `done`) in the logs ([Rotation](#rotation) says where). A pull request opened before the Pull request event was
   subscribed has no delivery in the App's Recent deliveries: open a new one. Retrying an analysis that failed while
   the container application was still provisioning comes with the deployed checks.

## Each release

1. The release pull request, the check with `--pre-tag` and the tag, as in [Releases](#releases).
2. Pick a quiet interval: no cloud job waiting or running, and no pushes or questions until the deploy's read-back is
   complete.
3. In a terminal with Docker running, with `PRQ_ACCESS_CLIENT_ID` and `PRQ_ACCESS_CLIENT_SECRET` set as for `prq`:
   `pnpm --dir packages/server run deploy -- vX.Y.Z`. It exits 0 once the read-back is complete.
4. Sign in at `https://<host>`: the web UI shows the new version. The checks after a deploy come with the deployed
   checks.
5. Remove the clone the deploy printed once you no longer need it.

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
- **A failed job** stays `failed` with its reason. Retrying it comes with the deployed checks.
- **A missing or malformed secret**: the Worker answers every protected request 500 when the Access team domain or
  audience is, and every delivery 500 when the webhook secret or the host's ID is; it logs `prq.config.invalid` naming
  the variable. `secrets status` names a missing secret: fix `worker.env`, then `secrets check` and `secrets put`.
- **The provider refuses a call** (a spend limit, a key or a model it does not accept): the job fails with
  `provider refused the request (HTTP <status>): <its message>`. Fix the credit or the key (`secrets put` for a new
  one), then retry the job.
- **Skill scripts refused** because an earlier run's processes could not be confirmed ended: the workspace runs no
  script until its container stops, 30 minutes after its last request.
- **An Access session that ended in the browser**: reload the page; Access asks for a one-time PIN again.

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
