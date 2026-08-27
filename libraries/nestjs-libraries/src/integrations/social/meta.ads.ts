/**
 * Discovery of a Meta account's ads, shared by the Facebook and Instagram
 * providers.
 *
 * Neither `/{page-id}/posts` nor `/{ig-user-id}/media` ever returns the posts
 * behind ads — Meta says so explicitly for Instagram, and dark posts are
 * unpublished by definition on Facebook. `/{page-id}/ads_posts` is the
 * purpose-built edge but needs `pages_manage_ads`, which is not offered to every
 * app type, so both providers instead walk the Marketing API:
 *
 *   ad accounts -> /act_*\/ads -> ad.creative.<the id this platform wants>
 *
 * Facebook reads `effective_object_story_id` (a page post id) and Instagram
 * `effective_instagram_media_id`. Both ids then work on the ordinary comment
 * endpoints, which is why replying and hiding need no ad-specific code at all.
 *
 * Needs `ads_management` on a USER token — a Page token cannot resolve `me` to a
 * user, so `/me/adaccounts` fails on one.
 *
 * ## Read everything, or say that you didn't
 *
 * This walk used to read the first page of the first five ad accounts. Both
 * bounds were silent, and both were wrong in production:
 *
 * - `/me/adaccounts` only returns accounts the user is DIRECTLY assigned to.
 *   Accounts owned by a Business Manager are reachable only through
 *   `/me/businesses` -> `owned_ad_accounts` / `client_ad_accounts`. On the live
 *   account that prompted this, `/me/adaccounts` returned 8 while 49 were
 *   reachable, and every account that was actually running ads was in the 41
 *   this edge omits.
 * - `/act_*\/ads` returns ads in no useful order (`sort` and `date_preset` are
 *   accepted and then ignored on this edge — verified live), so "the first 50"
 *   is an arbitrary slice, not the newest. One account held 2,961 ads of which
 *   119 were newer than the slice being read.
 *
 * So both edges are now paged to exhaustion, bounded only by ad creation date
 * (AD_HISTORY_DAYS), and anything that cannot be read — an ad account, or an
 * account-discovery edge — is REPORTED rather than silently contributing zero
 * ads. A partial answer that looks complete is the failure mode this module
 * exists to avoid, and it has already appeared here in three different guises:
 * a five-account cap, a first-page-only read, and a swallowed business edge.
 */

// Graph caps `limit` well below this on some edges and simply returns fewer
// rows; asking high just means fewer round trips where it is allowed. Large
// accounts answer a 500-row page in about a second.
const AD_PAGE_SIZE = 500;
// Some accounts answer a wide `fields` set at a large page size with
// "Please reduce the amount of data you're asking for" (error code 1, subcode
// 99). Verified live. Halve and retry rather than losing the account.
const MIN_PAGE_SIZE = 25;
// Ad accounts are walked concurrently, but a business with dozens of them
// should not open dozens of request chains at once against a shared app quota.
const ACCOUNT_CONCURRENCY = 8;
/**
 * How far back the ad walk reaches.
 *
 * Ads are never deleted, so an established advertiser's `/ads` edge grows
 * without bound: the live account holds 54,201 ads across 49 accounts backing
 * 24,875 distinct Instagram media, and reading all of it takes 5.4 minutes
 * (measured). Ad accounts are also walked on every creative field set, so that
 * cost repeats per channel.
 *
 * This is a moderation screen, and comment activity on an ad stops when its
 * delivery does — a sample of 400 of the oldest hidden media turned up 8
 * comments, all from 2018. So the walk is bounded by ad creation date instead
 * of by an arbitrary count. The bound is REPORTED (`MetaAdsResult.since`),
 * which is the whole difference between this and the silent five-account cap
 * it replaces.
 */
const AD_HISTORY_DAYS = 365;
/**
 * The Marketing API meters per ad account and a walk touches dozens of them, so
 * throttling is expected rather than exceptional. Waiting is free here — this
 * runs in the background — and the alternative is dropping an account's ads.
 *
 * Mutable only so the checks can pin the retry without sleeping for it.
 */
export class MetaAdsThrottle {
  // 60s, then 120s, then 180s. Meta's ads quota is a decaying score rather than
  // a fixed window, so short retries just spend more of it; 30s x3 was measured
  // to be too little to recover a genuinely exhausted ad account.
  static backoffMs = 60000;
  static retries = 3;
}

export type MetaAd = {
  name?: string;
  created_time?: string;
  creative?: Record<string, any>;
};

export type MetaAdAccount = {
  id: string;
  name?: string;
};

export type MetaAdsResult = {
  ads: MetaAd[];
  /** Every ad account we found, whether or not its ads could be read. */
  accounts: MetaAdAccount[];
  /**
   * Accounts whose ads could not be read. Non-empty means `ads` is a PARTIAL
   * answer — callers that present it as the whole set are lying to a moderator.
   */
  unreadable: { id: string; reason: string }[];
  /** Epoch second the walk was bounded at. See AD_HISTORY_DAYS. */
  since: number;
};

type Fetcher = (url: string) => Promise<{ json: () => Promise<any> }>;

const GRAPH = 'https://graph.facebook.com/v20.0';

/**
 * Follows `paging.next` until the edge is exhausted.
 *
 * Termination is on `paging.next` alone: Graph returns `paging.cursors.after` on
 * the last page too, so a cursor-based loop never ends. `next` already carries
 * the access token and every query parameter, so it is followed verbatim.
 */
async function pageAll(firstUrl: string, doFetch: Fetcher): Promise<any[]> {
  let waits = 0;

  for (;;) {
    try {
      const rows: any[] = [];
      let url: string | undefined = firstUrl;

      while (url) {
        const page: any = await (await doFetch(url)).json();

        if (page?.error) {
          throw Object.assign(new Error(page.error.message || 'Graph error'), {
            graphError: page.error,
          });
        }

        rows.push(...((page?.data || []) as any[]));
        url = page?.paging?.next || undefined;
      }

      return rows;
    } catch (err) {
      // Throttling is expected, not exceptional: the Marketing API meters per
      // ad account and a walk touches dozens of them. This runs in the
      // background with no deadline, so waiting is free — and the alternative
      // is an account's ads quietly going missing.
      if (!isRateLimit(err) || waits >= MetaAdsThrottle.retries) {
        throw err;
      }
      waits++;
      await new Promise((resolve) =>
        setTimeout(resolve, MetaAdsThrottle.backoffMs * waits)
      );
    }
  }
}

/** Same, but halves the page size when Graph says the request is too big. */
async function pageAllWithBackoff(
  buildUrl: (limit: number) => string,
  doFetch: Fetcher
): Promise<any[]> {
  let limit = AD_PAGE_SIZE;

  for (;;) {
    try {
      return await pageAll(buildUrl(limit), doFetch);
    } catch (err: any) {
      const tooMuch =
        err?.graphError?.code === 1 ||
        /reduce the amount of data/i.test(err?.message || '');

      if (!tooMuch || limit <= MIN_PAGE_SIZE) {
        throw err;
      }

      limit = Math.max(MIN_PAGE_SIZE, Math.floor(limit / 2));
    }
  }
}

/**
 * Meta spells throttling several ways and the ads-specific one carries no
 * distinctive code, so the message is part of the test. 4/17/32 are the app,
 * user and page limits; 613 is the Marketing API's own.
 */
export function isRateLimit(err: any): boolean {
  const code = err?.graphError?.code;

  return (
    [4, 17, 32, 613].includes(code) ||
    /too many calls|request limit reached|rate limit/i.test(err?.message || '')
  );
}

/** Runs `worker` over `items`, at most `width` at a time. */
export async function mapLimit<T, R>(
  items: T[],
  width: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) {
          return;
        }
        results[index] = await worker(items[index]);
      }
    })
  );

  return results;
}

/**
 * Every ad account this user token can reach.
 *
 * `/me/adaccounts` is only the accounts the user is personally assigned to. The
 * accounts a business owns — which is where an organisation's real advertising
 * lives — come off the business edges, and a user can be in several businesses.
 * All three edges are paged, and the union is de-duplicated because an account
 * commonly appears on more than one.
 *
 * One unreadable edge does not lose the others, but it is never swallowed: an
 * earlier version returned `[]` for a failed business edge and two consecutive
 * live runs then found 49 and 35 accounts while both reported everything as
 * fine. An ad account that is missing from this list contributes no ads and no
 * error, which is indistinguishable from an advertiser who has not run ads —
 * the precise confusion this module exists to prevent.
 */
export async function fetchMetaAdAccounts(
  userToken: string,
  doFetch: Fetcher
): Promise<{
  accounts: MetaAdAccount[];
  failed: { id: string; reason: string }[];
}> {
  const byId = new Map<string, MetaAdAccount>();
  const failed: { id: string; reason: string }[] = [];

  const read = async (id: string, url: string) => {
    try {
      for (const row of await pageAll(url, doFetch)) {
        if (row?.id && !byId.has(String(row.id))) {
          byId.set(String(row.id), { id: String(row.id), name: row.name });
        }
      }
    } catch (err: any) {
      failed.push({
        id,
        reason: err?.graphError?.message || err?.message || 'unknown',
      });
    }
  };

  await read(
    'me/adaccounts',
    `${GRAPH}/me/adaccounts?fields=id,name&limit=200&access_token=${userToken}`
  );

  let businesses: any[] = [];
  try {
    businesses = await pageAll(
      `${GRAPH}/me/businesses?fields=id&limit=200&access_token=${userToken}`,
      doFetch
    );
  } catch (err: any) {
    failed.push({
      id: 'me/businesses',
      reason: err?.graphError?.message || err?.message || 'unknown',
    });
  }

  await mapLimit(
    businesses.flatMap((business: any) =>
      ['owned_ad_accounts', 'client_ad_accounts'].map((edge) => ({
        business,
        edge,
      }))
    ),
    ACCOUNT_CONCURRENCY,
    ({ business, edge }) =>
      read(
        `${business.id}/${edge}`,
        `${GRAPH}/${business.id}/${edge}?fields=id,name&limit=200&access_token=${userToken}`
      )
  );

  return { accounts: [...byId.values()], failed };
}

/**
 * Every ad reachable by this user token, with the requested creative fields.
 *
 * Never throws for a missing ads permission — an optional ads listing must not
 * take the organic one down with it — but an account that fails is recorded in
 * `unreadable` so the caller can tell a partial answer from a complete one.
 */
export async function fetchMetaAds(
  userToken: string,
  creativeFields: string[],
  doFetch: Fetcher,
  since = Math.floor(Date.now() / 1000) - AD_HISTORY_DAYS * 86400
): Promise<MetaAdsResult> {
  // An edge that could not be listed is an account list we know is short, so it
  // belongs in `unreadable` beside the accounts that failed their ads walk. No
  // ads permission at all lands here too, as three failed edges and no accounts.
  const { accounts, failed } = await fetchMetaAdAccounts(userToken, doFetch);
  const unreadable = [...failed];

  const fields = `name,created_time,creative{${creativeFields.join(',')}}`;
  // `sort` and `date_preset` are accepted and then ignored on this edge, so the
  // window has to be a filter — verified live, and it is what makes 49 accounts
  // tractable: a long-dormant account answers with 0 rows in under a second
  // instead of paging out thousands of ads from 2017.
  const filtering = encodeURIComponent(
    JSON.stringify([
      { field: 'ad.created_time', operator: 'GREATER_THAN', value: since },
    ])
  );

  const adsUrl = (accountId: string, limit: number) =>
    `${GRAPH}/${accountId}/ads` +
    `?fields=${encodeURIComponent(fields)}` +
    `&filtering=${filtering}` +
    `&limit=${limit}&access_token=${userToken}`;

  const readAccount = async (accountId: string) =>
    (await pageAllWithBackoff(
      (limit) => adsUrl(accountId, limit),
      doFetch
    )) as MetaAd[];

  const perAccount = await mapLimit(
    accounts,
    ACCOUNT_CONCURRENCY,
    async (account) => {
      try {
        return await readAccount(account.id);
      } catch (err: any) {
        // One ad account the user can list but not read must not take the other
        // accounts' ads down with it — a common agency setup. Meta answers that
        // with error_subcode 33, which both providers' handleErrors classes as
        // an expired token, so this has to swallow RefreshToken as well:
        // rethrowing it would mark a perfectly healthy channel as needing
        // reconnection just because one ad account is off limits.
        unreadable.push({
          id: account.id,
          reason: err?.graphError?.message || err?.message || 'unknown',
        });
        return [] as MetaAd[];
      }
    }
  );

  // A concurrent walk of dozens of accounts regularly gets "Unknown Error" on
  // a handful that answer fine a moment later on their own. Retry those
  // serially before freezing the short list in the cache.
  for (let i = 0; i < accounts.length; i++) {
    const miss = unreadable.findIndex((row) => row.id === accounts[i].id);
    if (miss < 0) {
      continue;
    }
    try {
      perAccount[i] = await readAccount(accounts[i].id);
      unreadable.splice(miss, 1);
    } catch (err: any) {
      unreadable[miss] = {
        id: accounts[i].id,
        reason: err?.graphError?.message || err?.message || unreadable[miss].reason,
      };
    }
  }

  return { ads: perAccount.flat(), accounts, unreadable, since };
}

/**
 * Distinct ids off a set of ads, keeping the first ad that referenced each one
 * as a fallback card. One creative can back several ads.
 */
export function adsByCreativeId(
  ads: MetaAd[],
  field: string,
  isMine?: (ad: MetaAd) => boolean
): Map<string, MetaAd> {
  const byId = new Map<string, MetaAd>();

  for (const ad of ads) {
    const id = ad?.creative?.[field];
    if (!id || (isMine && !isMine(ad))) {
      continue;
    }
    if (!byId.has(String(id))) {
      byId.set(String(id), ad);
    }
  }

  return byId;
}
