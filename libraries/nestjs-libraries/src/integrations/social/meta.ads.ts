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
 *   /me/adaccounts -> /act_*\/ads -> ad.creative.<the id this platform wants>
 *
 * Facebook reads `effective_object_story_id` (a page post id) and Instagram
 * `effective_instagram_media_id`. Both ids then work on the ordinary comment
 * endpoints, which is why replying and hiding need no ad-specific code at all.
 *
 * Needs `ads_management` on a USER token — a Page token cannot resolve `me` to a
 * user, so `/me/adaccounts` fails on one.
 */

// ponytail: first page of the first few ad accounts. Ads are a bounded set next
// to a whole posting history, and this runs on every comment-screen load — page
// the walk, or cache it the way the TikTok crawl does, if an account ever runs
// more ads than this covers.
const MAX_AD_ACCOUNTS = 5;
const AD_PAGE_SIZE = 50;

export type MetaAd = {
  name?: string;
  created_time?: string;
  creative?: Record<string, any>;
};

type Fetcher = (url: string) => Promise<{ json: () => Promise<any> }>;

/**
 * Every ad reachable by this user token, with the requested creative fields.
 *
 * Returns [] rather than throwing when the ads permission is missing, so an
 * optional ads listing can never take down the organic one. Callers are still
 * expected to wrap this — a token that is outright dead should surface through
 * whatever organic request runs beside it, not through here.
 */
export async function fetchMetaAds(
  userToken: string,
  creativeFields: string[],
  doFetch: Fetcher
): Promise<MetaAd[]> {
  const accounts = await (
    await doFetch(
      `https://graph.facebook.com/v20.0/me/adaccounts?fields=id&limit=${MAX_AD_ACCOUNTS}&access_token=${userToken}`
    )
  ).json();

  const fields = `name,created_time,creative{${creativeFields.join(',')}}`;

  const perAccount = await Promise.all(
    (accounts.data || []).map((account: any) =>
      doFetch(
        `https://graph.facebook.com/v20.0/${account.id}/ads` +
          `?fields=${encodeURIComponent(fields)}` +
          `&limit=${AD_PAGE_SIZE}&access_token=${userToken}`
      )
        .then((response) => response.json())
        .then((response) => (response.data || []) as MetaAd[])
        .catch(() => {
          // One ad account the user can list but not read must not take the
          // other accounts' ads down with it — a common agency setup. Meta
          // answers that with error_subcode 33, which both providers'
          // handleErrors classes as an expired token, so this has to swallow
          // RefreshToken as well: rethrowing it would mark a perfectly healthy
          // channel as needing reconnection just because one ad account is off
          // limits.
          return [] as MetaAd[];
        })
    )
  );

  return perAccount.flat();
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
