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

## Ad comments

The comment screen lists a channel's ads alongside its organic posts. Reply and
hide needed no work: both Meta providers ignore `postId` and act on the comment
id alone, so the whole feature was a *listing* problem.

Both Meta providers discover ads the same way, through `meta.ads.ts`:
`/me/adaccounts` → `/act_*/ads` → the creative id that platform needs.

- **Facebook** — `creative.effective_object_story_id` (a `<page-id>_<post-id>`
  page post), then a batched node read with the **page** token to build the card.
  The user token comes from `Integration.refreshToken`; Facebook's
  `refreshToken()` is a no-op stub, so nothing ever overwrites it.
  Filter on the `<page-id>_` prefix — one ad account commonly promotes several
  Pages.
- **Instagram** — `creative.effective_instagram_media_id`, using the **user**
  half of the `page___user` token. `/{ig-user-id}/media` can never return ad
  media. Ad and organic comments are disjoint (`effective_` vs
  `source_instagram_media_id`), so a boosted post has its comments split across
  two media ids.

- **instagram-standalone** — no ad surface at all; the ads branch is gated on
  the `graph.facebook.com` host so it never fires there.
- **TikTok** — covered by a separate `tiktok-business-ads` channel on the
  advertiser surface; see the next section.

**Why not `/{page-id}/ads_posts`?** It is the purpose-built edge and returns
richer objects in one call, but it additionally requires `pages_manage_ads` —
and that permission is **not offered to every app type**. The production app
(`970582635985004`, `app_type: 0`, created through the legacy "Other" flow) has
no way to obtain it: searching for it under App Review → Permissions and
Features returns nothing, with Meta's own message saying the catalogue is capped
"based on your app type" and pointing at creating a new app. `pages_manage_ads`
is *not* deprecated — it is still listed as required for `ads_posts` on every
live Graph version (v20–v26) — it simply is not available here. Getting it back
means creating a new use-case-type app and migrating `FACEBOOK_APP_ID`/`SECRET`.

### The permission, and why nothing breaks without it

`ads_management` (Facebook) and `ads_read` + `ads_management` (Instagram) are
declared in `optionalScopes`, not `scopes`. `checkScopes` is all-or-nothing and throws
`NotEnoughScopes`, so listing an ads permission as required would make the
channel impossible to *connect* — not merely hide ad posts. They are appended to
the auth dialog only. (Verified against the live dialog: both are accepted,
an unknown scope 500s.)

**App Review is not needed for this deployment.** The app's Advanced Access list
is only `email` and `public_profile`, yet twelve permissions work — because the
app has exactly one role holder, an administrator, and Business apps get
Standard Access automatically for every permission their app type offers. Meta:
*"If your app will only be used by app users who have a role on the app itself,
App Review is not required."* Do not request Advanced Access; that is the only
thing that triggers review and Business Verification.

⚠️ **Granting a narrower scope set REVOKES the rest.** Meta grants permissions
per user+app, not per token. Authorising through the Graph API Explorer with
only `ads_management`/`ads_read` selected revoked all ten page/Instagram
permissions and invalidated the stored page tokens — publishing and comments
both went down until the channels were reconnected. Always re-authorise through
Postiz itself, which asks for the full list. Note also that `ads_management`
*depends on* `pages_read_engagement` and `pages_show_list`, so an ads-only grant
is never a complete one.

When diagnosing a `(#200) Not enough permission`, append `debug=all` to the
request — Graph then returns a `__debug__.messages` array naming the missing
permission instead of the deliberately generic code.

Not moderatable at all, by Meta's own docs: Advantage+ catalog ads, story ads,
age-restricted media, and Instagram-placement comments on a Facebook ad (those
live on the IG media, not the page post).

Ordering: Facebook pages both edges behind one cursor (`organic~ads`); Instagram
pulls its whole ad set on the first page because the Marketing API has its own
paging. Either way a later page can carry something newer, so the screen re-sorts
after each append rather than trusting append order.

Check the merge/cursor/degradation logic with:

```bash
npx tsx --tsconfig tsconfig.base.json var/checks/comment.ad.posts.ts
```

## TikTok Ads comments (`tiktok-business-ads`)

A **third** TikTok surface, separate from `tiktok` (consumer) and
`tiktok-business` (tt_user). Ads comments live on the Marketing API's
`/open_api/v1.3/comment/*` namespace — **no `/business/` prefix** — keyed by
`advertiser_id`, and the tt_user token is rejected there with `40105` (verified
live: the same token returns `code 0` from `/business/get/` in the same minute).

It is a separate provider, not a second token on `tiktok-business`, because
`RefreshIntegrationService` writes `refreshToken()`'s result back as the *whole*
`Integration.token` column and the tt_user token lasts ~23h — a composite token
would be destroyed daily. It needs no Prisma change.

| Operation | Endpoint |
|---|---|
| list ad groups | `GET /adgroup/get/` (skip `comment_disabled`) |
| list comments | `GET /comment/list/` — `search_field` accepts **`ADGROUP_ID` and nothing else**, so there is no by-ad, by-video or account-wide listing |
| reply | `POST /comment/post/` — eight required fields; `comment_type` must be the literal `REPLY` (the row's enum is `{COMMENT,REPLY}`, this field's is `{POST,REPLY}`) |
| hide/unhide | `POST /comment/status/update/` — `operation` is `HIDDEN`/`PUBLIC`, **not** `HIDE`/`UNHIDE`. `/comment/hide/` does not exist here |

There is no posts-with-comments endpoint, so posts are derived by grouping
`/comment/list/` rows on `tiktok_item_id`; `postId` is minted as
`<adgroup_id>:<item_id>` and the comment id as
`<comment_id>:<ad_id>:<identity_type>:<identity_id>` so replying costs no extra
lookup. Both are opaque to the service, controllers, MCP tools and UI.
`create_time` is a **string** here, rendered three incompatible ways across
TikTok's own docs — `dayjs.unix()` (correct on the organic surface) produces an
Invalid Date; parse with `dayjs.utc()` and an epoch fallback.

**One authorization imports every advertiser.** `authenticate()` returns an
array (`IAuthenticator.authenticate` is widened to
`AuthTokenDetails | AuthTokenDetails[]`): the provider unions the token
response's `advertiser_ids` with `/oauth2/advertiser/get/` (names resolved in
one call), and the OAuth callback upserts each row idempotently with the shared
long-lived token. Reconnecting any one of them rotates the token on all rows.
Verified live 2026-08-23: 25 advertisers imported, one token, no duplicates.

### Setup — none of this can be done from code

1. **Same app**, no new registration: the existing `TIKTOK_BUSINESS_APP_ID` /
   `TIKTOK_BUSINESS_APP_SECRET` are confirmed valid on the advertiser token
   endpoint. One app, two independent authorization surfaces.
2. In `business-api.tiktok.com/portal/apps` → App Detail → Authorization →
   **Scope of permission**, request: `15000000` Ad Comments, `210` Read Ad
   Groups, `220` Read Ads, `693` Query Identity, `100` Read Ad Account
   Information. Ask for all five at once — a narrower grant costs a second
   re-authorization with every advertiser. TikTok review is 2-3 business days
   and rejectable.
3. Register `<FRONTEND_URL>/integrations/social/tiktok-business-ads` as an
   **advertiser** redirect URL (max 10).
4. An advertiser walks the authorization URL, confirms, and enters a code TikTok
   emails to the ad account.

⚠️ Editing the app's permission set is untested against the live organic
channel — it is the same app record. Everything else here is additive.

### Two things to settle on the first real token

- **Does hiding on one surface hide on the other?** Undocumented anywhere. A
  public Spark Ad *is* its organic post, so its comments appear in both this
  channel and `tiktok-business`. If the flag is not shared, a moderator can hide
  abuse here and it stays publicly visible on the organic post — a moderation
  tool lying about having removed something. Prove it before trusting the badge:
  hide via `/comment/status/update/`, re-read the same `comment_id` via
  `/business/comment/list/`.
- **Do rows actually populate `identity_id` / `identity_type` /
  `tiktok_item_id`?** TikTok's only published sample omits all three. The
  provider falls back to a lookup and then to a clear error, but this decides
  whether replying works at all for uploaded-creative ads.

Everything in `/comment/*` is documentation-derived and has never been exercised
— the surface cannot be probed without a real advertiser token. Expect named
`40002` field errors on the first live call and correct them there.

```bash
npx tsx --tsconfig tsconfig.base.json var/checks/tiktok.ads.comments.ts
```

## TikTok Business (`tiktok-business`)

Comment moderation only — it cannot publish. Two hard-won details, both
documented in the provider:

- It uses the **account-holder (`tt_user`) OAuth surface**, not the advertiser
  one. The advertiser flow returns `advertiser_ids` and its token is rejected
  with `40105` by every `/business/*` endpoint.
- Its video list can't be paged: the cursor only looks back a few hours, so the
  timeline is crawled in slices in the background and the screen is served from
  the `CommentPost` cache. See `commentPostsSliceMs` and `crawlCommentPosts`.

When an endpoint's parameters are unknown, probe it — the `/business/*` surface
validates field names before credentials and names the allowed values in the
error message (`40002 Missing required field(s): creator_id or business_id.`).

This does **not** transfer to the advertiser surface: `/open_api/v1.3/<resource>/`
checks the token first, so a bogus token returns an undifferentiated `40105` no
matter what you send. Use TikTok's own OpenAPI schemas instead
(`github.com/tiktok/tiktok-business-api-sdk`, `yml_files/`) plus the portal docs,
which are reachable without JS at
`business-api.tiktok.com/gateway/api/doc/client/node/get/v2/?doc_id=<id>`. Path
existence and HTTP verb *are* still probeable: a missing path answers plain-text
`Not Found` (404) and a wrong verb `Method Not Allowed` (405), both before the
token check.
