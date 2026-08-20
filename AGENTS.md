# Agent instructions (blubblub fork)

Fork-specific notes. Upstream's `CLAUDE.md` still applies for how the codebase is
laid out — this file covers what is different about *our* deployment, and is kept
separate so upstream merges don't conflict.

## Production instance

| | |
|---|---|
| URL | https://postiz.blubtools.com (`FRONTEND_URL`) |
| Host | DigitalOcean droplet `165.245.254.117`, root SSH (IP already public in the deploy workflow) |
| App directory | `/opt/postiz` |
| Containers | `postiz`, `postiz-postgres`, `postiz-redis`, `temporal`, `caddy` |

Not visible through the local `doctl` contexts — the droplet is not in
`blubblub-sandbox` or `unifiedsense`, and `blubtools.com`'s DO DNS zone has no
`postiz` record. Don't waste time looking for it there.

### Standing authorization

**Connect to production and investigate directly. Do not ask first.** Read logs,
query the database, inspect containers and config, and call third-party APIs with
the stored tokens to reproduce a problem. Report what you find.

This covers investigation. It does **not** cover:

- Destructive or irreversible changes (dropping/altering data, deleting
  containers or files, rotating credentials, `docker compose down`).
- Writes to third-party accounts — posting, replying, hiding, deleting on a
  connected social account is publicly visible under the customer's brand.
- Anything that takes the site down.

Confirm those before acting. Editing config and restarting the app to fix a
problem is fine; say what you changed and keep a backup of what you replaced.

### Configuration

There is **no `.env` file and no `env_file:` directive.** Credentials live
directly in `services.postiz.environment` in
`/opt/postiz/docker-compose.override.yaml` (`FACEBOOK_APP_ID`, `OPENAI_API_KEY`,
`JWT_SECRET`, `TIKTOK_BUSINESS_APP_ID`, …). Adding an env var to the repo's
`docker-compose.yaml` does not put it on the droplet — that file enumerates
provider credentials explicitly, and the droplet keeps its own copy.

Apply changes with `docker compose up -d postiz` in `/opt/postiz`, then confirm
with `docker exec postiz printenv <VAR>`. Back up the override first.

### Useful commands

```bash
# database (credentials come from the container's own env)
PGU=$(docker exec postiz-postgres printenv POSTGRES_USER)
PGD=$(docker exec postiz-postgres printenv POSTGRES_DB)
docker exec postiz-postgres psql -U "$PGU" -d "$PGD" -c '<sql>'

docker logs --since 30m postiz          # pm2 runs frontend, backend, orchestrator
docker ps --filter name=postiz          # health
```

## Deploys

Every push to `feature/integration` builds and auto-deploys to the droplet via
`.github/workflows/deploy-integration.yml` (~10 min, watch with `gh run watch`).
The workflow uses `concurrency: cancel-in-progress`, so pushing again kills an
in-flight deploy.

`prisma db push` runs on container start, so **schema changes apply themselves on
deploy** — this repo has no migration files. Regenerate types locally with
`pnpm run prisma-generate` (it dirties `pnpm-lock.yaml`; revert that before
committing).

If a deploy fails, check disk before suspecting the code: every deploy leaves a
tagged `ghcr.io/blubblub/postiz-app:integration-<sha>` image (~5.6GB), and
`docker image prune` only drops *dangling* images, so they accumulated until the
disk filled and layer extraction failed with `no space left on device`. The
droplet's `/usr/local/bin/postiz-deploy` now keeps the 3 newest sha-tagged
images and deletes the rest, and prints free disk on success. Deleted images are
re-pullable from GHCR.

Formatting: the codebase is prettier 2 (`trailingComma: es5`) but prettier 3 is
installed, so running it rewrites whole files. Format by hand.

## TikTok Business (`tiktok-business`)

Comment moderation only — it cannot publish. Two hard-won details, both
documented in the provider:

- It uses the **account-holder (`tt_user`) OAuth surface**, not the advertiser
  one. The advertiser flow returns `advertiser_ids` and its token is rejected
  with `40105` by every `/business/*` endpoint.
- Its video list can't be paged: the cursor only looks back a few hours, so the
  timeline is crawled in slices in the background and the screen is served from
  the `CommentPost` cache. See `commentPostsSliceMs` and `crawlCommentPosts`.

When an endpoint's parameters are unknown, probe it — these APIs validate field
names before credentials and name the allowed values in the error message.
