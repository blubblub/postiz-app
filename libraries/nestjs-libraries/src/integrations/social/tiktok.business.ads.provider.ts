import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialComment,
  SocialCommentPost,
  SocialCommentPostsPage,
  SocialCommentsPage,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import {
  BadBody,
  RefreshToken,
  SocialAbstract,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { Integration } from '@prisma/client';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';

dayjs.extend(utc);

// TikTok ADVERTISER (Marketing API) surface — a THIRD TikTok surface, distinct
// from both tiktok.provider.ts (consumer Login Kit) and
// tiktok.business.provider.ts (the tt_user "API for Business" account surface):
//
//   - host:  business-api.tiktok.com/open_api/v1.3/*  (NO /business/ prefix)
//   - auth:  advertiser authorization at business-api.tiktok.com/portal/auth,
//            exchanged at /oauth2/access_token/ with {app_id, secret, auth_code}
//            — NOT the client_id/client_secret/grant_type/redirect_uri shape the
//            tt_user flow uses.
//   - token: `Access-Token` header, same as the tt_user surface
//   - id:    advertiser_id
//
// Why this is a separate provider rather than a second token on tiktok-business:
// the tt_user token is rejected by every /open_api/v1.3/comment/* endpoint with
// 40105 (verified live — the same token returns code 0 from /business/get/ in
// the same minute), and packing two tokens into one Integration.token would be
// destroyed roughly daily, because RefreshIntegrationService writes the result
// of refreshToken() back as the entire token column and the tt_user token lasts
// ~23h.
//
// Organic vs ads coverage: a Spark Ad IS its organic post — one comment section,
// one comment id space — so a PUBLIC Spark Ad's comments are already moderatable
// through the tiktok-business channel and will appear in both. This channel's
// unique value is ads-only "dark" posts, which never reach the profile and which
// TikTok has defaulted API-created ads to since 2026-01-27.
const BASE = 'https://business-api.tiktok.com/open_api/v1.3';

// Separates the composite ids this provider mints. Every part is numeric or an
// enum word, and the ids travel raw in a URL path segment, so ':' is safe where
// '/', '?', '#' and '%' are not.
const PART = ':';

// /comment/list/ rejects spans over 30 days. Both bounds are inclusive, so
// subtract 29 days to cover 30 calendar days including today.
const LOOKBACK_DAYS = 29;

// Ad groups scanned per page of the comment screen. Each one costs a
// /comment/list/ call, so this is the fan-out width of a single request.
const ADGROUPS_PER_PAGE = 20;

// Pages of /comment/list/ walked when resolving the extra fields a reply needs.
const REPLY_LOOKUP_MAX_PAGES = 5;

export class TiktokBusinessRateLimit extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TiktokBusinessRateLimit';
  }
}

const isRateLimited = (code: number, message?: string) =>
  [40016, 40100, 40133, 50002].includes(code) ||
  /rate.?limit|too many requests|qps|frequen/i.test(String(message || ''));

/**
 * TikTok renders this field three incompatible ways across its own docs
 * ("2021-01-14 07:04:16 +0000 UTC", "YYYY-MM-DD HH:MM:SS", "2022-06-07") and it
 * is a string, not an epoch — so the organic provider's `dayjs.unix(Number(x))`
 * would produce an Invalid Date here. `.utc()` is load-bearing: bare
 * `dayjs('2021-01-14 07:04:16')` silently shifts by the server's local offset.
 */
const parseCreateTime = (value: unknown): dayjs.Dayjs | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const raw = String(value).replace(/\s+\+0000 UTC$/, '').trim();

  // Some surfaces do return an epoch; accept it rather than producing garbage.
  if (/^\d{9,13}$/.test(raw)) {
    const asNumber = Number(raw);
    const parsed = dayjs.unix(raw.length > 10 ? asNumber / 1000 : asNumber);
    return parsed.isValid() ? parsed : undefined;
  }

  const parsed = dayjs.utc(raw);
  return parsed.isValid() ? parsed : undefined;
};

@Rules(
  'TikTok Ads is a comment-management only channel for a TikTok ad account, it cannot publish posts'
)
export class TiktokBusinessAdsProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'tiktok-business-ads';
  name = 'Tiktok\n(Ads comments)';
  isBetweenSteps = false;
  toolTip =
    'Connect a TikTok ad account to moderate comments on its ads, including ads-only posts that never appear on the profile (this channel does not publish).';
  // The advertiser surface has no OAuth `scope` parameter — permissions are
  // selected on the app in the TikTok for Business developer portal and granted
  // by the advertiser at authorization time. See AGENTS.md for the list.
  scopes = [] as string[];
  editor = 'normal' as const;

  maxLength() {
    // ponytail: the ads /comment/post/ text cap is undocumented. TikTok raised
    // the ORGANIC reply cap from 150 to 1200 on 2026-08-07, so 1200 is the
    // informed guess; the API rejects overruns with a named-field error, so a
    // wrong value fails loudly rather than truncating.
    return 1200;
  }

  // Comment moderation only — block scheduling at the composer validation layer,
  // with post() as the hard backstop.
  override async checkValidity(): Promise<string | true> {
    return 'TikTok Ads channels manage comments on ads only — they cannot publish posts.';
  }

  async post(
    _id: string,
    _accessToken: string,
    _postDetails: PostDetails[],
    _integration: Integration
  ): Promise<PostResponse[]> {
    throw new BadBody(
      'tiktok-business-ads',
      '{}',
      Buffer.from('{}'),
      'TikTok Ads channels cannot publish posts, they are used to moderate comments on ads only.'
    );
  }

  // ---------------------------------------------------------------------------
  // OAuth (advertiser authorization)
  // ---------------------------------------------------------------------------
  private redirectUri() {
    return `${
      process?.env?.FRONTEND_URL?.indexOf('https') === -1
        ? 'https://redirectmeto.com/'
        : ''
    }${process?.env?.FRONTEND_URL}/integrations/social/tiktok-business-ads`;
  }

  async generateAuthUrl() {
    const state = Math.random().toString(36).substring(2);
    return {
      // The advertiser authorization page. This is a DIFFERENT entry point from
      // the tt_user page the organic channel uses, and the redirect_uri must be
      // registered on the app as an advertiser redirect URL or TikTok refuses
      // the callback after login.
      url:
        'https://business-api.tiktok.com/portal/auth' +
        `?app_id=${process.env.TIKTOK_BUSINESS_APP_ID}` +
        `&state=${state}` +
        `&redirect_uri=${encodeURIComponent(this.redirectUri())}`,
      codeVerifier: state,
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }): Promise<AuthTokenDetails> {
    // Live-confirmed against the real app credentials: this endpoint takes
    // exactly app_id, secret and auth_code, all as JSON strings, and validates
    // the body schema BEFORE credentials. grant_type and redirect_uri are
    // ignored rather than rejected, so they are simply not sent.
    const res = await (
      await fetch(`${BASE}/oauth2/access_token/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: String(process.env.TIKTOK_BUSINESS_APP_ID),
          secret: String(process.env.TIKTOK_BUSINESS_APP_SECRET),
          auth_code: params.code,
          // Sent explicitly rather than trusting the documented default — a
          // silent `false` would complete the connect with no advertiser id,
          // leaving a channel that can never call anything.
          return_advertiser_ids: true,
        }),
      })
    ).json();

    const data = res?.data || {};
    const accessToken = data.access_token;
    const advertiserId = String(
      (data.advertiser_ids || [])[0] || data.advertiser_id || ''
    );

    if (!accessToken || !advertiserId) {
      throw new BadBody(
        'tiktok-business-ads',
        JSON.stringify(res),
        Buffer.from(JSON.stringify(res || {})),
        res?.message ||
          'Could not authenticate the TikTok ad account. Make sure the advertiser completed the authorization and the app is approved for the ad comment permissions.'
      );
    }

    const name = await this.advertiserName(accessToken, advertiserId);

    return {
      id: advertiserId,
      name,
      accessToken,
      // The advertiser token is long-lived and has no refresh endpoint. Keeping
      // a copy here lets refreshToken() re-assert it instead of returning empty
      // strings, which the refresh path treats as a dead channel and
      // disconnects.
      refreshToken: accessToken,
      expiresIn: dayjs().add(1, 'year').unix() - dayjs().unix(),
      picture: '',
      username: advertiserId,
    };
  }

  /**
   * The advertiser token does not expire and TikTok publishes no refresh
   * endpoint for it, so re-assert the stored token rather than returning empty
   * strings — RefreshIntegrationService reads an empty accessToken as a dead
   * channel and disconnects it.
   */
  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    const advertiserId = await this.firstAdvertiserId(refreshToken);

    return {
      id: advertiserId,
      name: await this.advertiserName(refreshToken, advertiserId),
      accessToken: refreshToken,
      refreshToken,
      expiresIn: dayjs().add(1, 'year').unix() - dayjs().unix(),
      picture: '',
      username: advertiserId,
    };
  }

  private async firstAdvertiserId(accessToken: string): Promise<string> {
    const data = await this.call<any>('/oauth2/advertiser/get/', accessToken, {
      query: {
        app_id: String(process.env.TIKTOK_BUSINESS_APP_ID),
        secret: String(process.env.TIKTOK_BUSINESS_APP_SECRET),
      },
    }).catch(() => undefined);

    return String((data?.list || [])[0]?.advertiser_id || '');
  }

  private async advertiserName(
    accessToken: string,
    advertiserId: string
  ): Promise<string> {
    const data = await this.call<any>('/oauth2/advertiser/get/', accessToken, {
      query: {
        app_id: String(process.env.TIKTOK_BUSINESS_APP_ID),
        secret: String(process.env.TIKTOK_BUSINESS_APP_SECRET),
      },
    }).catch(() => undefined);

    const found = (data?.list || []).find(
      (advertiser: any) => String(advertiser.advertiser_id) === advertiserId
    );

    return found?.advertiser_name || `TikTok Ads ${advertiserId}`;
  }

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  private window() {
    const end = dayjs();
    return {
      start_time: end.subtract(LOOKBACK_DAYS, 'day').format('YYYY-MM-DD'),
      end_time: end.format('YYYY-MM-DD'),
    };
  }

  /**
   * /comment/list/ can only be filtered by ADGROUP_ID — there is no by-ad,
   * by-video or account-wide listing — so every read starts by enumerating ad
   * groups.
   */
  private async adGroups(
    advertiserId: string,
    accessToken: string,
    page: number
  ): Promise<{ ids: string[]; hasMore: boolean }> {
    const data = await this.call<any>('/adgroup/get/', accessToken, {
      query: {
        advertiser_id: advertiserId,
        fields: ['adgroup_id', 'adgroup_name', 'comment_disabled'],
        page,
        page_size: ADGROUPS_PER_PAGE,
      },
    });

    const ids = (data?.list || [])
      // Ad groups with comments switched off can never have any; skipping them
      // saves a /comment/list/ round trip each.
      .filter((group: any) => !group.comment_disabled)
      .map((group: any) => String(group.adgroup_id))
      .filter(Boolean);

    const info = data?.page_info || {};
    return {
      ids,
      hasMore: Number(info.page || page) < Number(info.total_page || page),
    };
  }

  private async comments(
    advertiserId: string,
    accessToken: string,
    adGroupId: string,
    page = 1
  ): Promise<{ rows: any[]; hasMore: boolean }> {
    const data = await this.call<any>('/comment/list/', accessToken, {
      query: {
        advertiser_id: advertiserId,
        ...this.window(),
        search_field: 'ADGROUP_ID',
        search_value: adGroupId,
        // Arrays, not scalars, on this surface. ALL keeps hidden comments in the
        // list — a moderation screen that silently dropped them could never
        // unhide anything.
        comment_type: ['ALL'],
        comment_status: ['ALL'],
        page,
        page_size: 100,
      },
    });

    const info = data?.page_info || {};
    return {
      rows: data?.comments || [],
      hasMore: Number(info.page || page) < Number(info.total_page || page),
    };
  }

  async fetchCommentPosts(
    id: string,
    accessToken: string,
    _integration: Integration,
    limit = 25,
    cursor?: string
  ): Promise<SocialCommentPostsPage> {
    const page = Math.max(Number(cursor) || 1, 1);
    const { ids, hasMore } = await this.adGroups(id, accessToken, page);

    // ponytail: sequential calls stay below TikTok's live QPS limit; add bounded
    // concurrency only if a 20-group page becomes measurably too slow.
    const grouped: { adGroupId: string; rows: any[] }[] = [];
    for (const adGroupId of ids) {
      const { rows } = await this.comments(id, accessToken, adGroupId);
      grouped.push({ adGroupId, rows });
    }

    // The ads surface has no "posts that have comments" endpoint, so posts are
    // derived by grouping comments on the item they were left on. A pleasant
    // side effect: only posts that actually have comments are listed.
    const posts = new Map<string, SocialCommentPost>();
    for (const { adGroupId, rows } of grouped) {
      for (const row of rows) {
        const itemId = String(row.tiktok_item_id || '');
        if (!itemId) {
          continue;
        }

        const postId = `${adGroupId}${PART}${itemId}`;
        const createdAt = parseCreateTime(row.create_time);
        const existing = posts.get(postId);

        if (!existing) {
          posts.set(postId, {
            id: postId,
            releaseId: postId,
            content: row.ad_text || row.adgroup_name || 'TikTok ad',
            // Never emit an unparseable date: the comment screen formats it and
            // the shared cache would write it into a NOT NULL column.
            publishDate: (createdAt || dayjs()).toISOString(),
            thumbnail: row.video_cover_url,
            commentCount: 1,
            likeCount: 0,
            isAd: true,
          });
          continue;
        }

        existing.commentCount = (existing.commentCount || 0) + 1;
        // Show the most recent activity on the post rather than whichever
        // comment happened to come back first.
        if (createdAt && createdAt.toISOString() > existing.publishDate) {
          existing.publishDate = createdAt.toISOString();
        }
      }
    }

    const list = [...posts.values()].sort((a, b) =>
      (b.publishDate || '').localeCompare(a.publishDate || '')
    );

    return {
      posts: list,
      total: list.length,
      page,
      limit,
      hasMore,
      next: hasMore ? String(page + 1) : undefined,
    };
  }

  /**
   * A comment id has to carry what /comment/post/ needs beyond the post id, so
   * replying costs no extra lookup in the common case. Ids are opaque to the
   * service, the controllers, the MCP tools and the UI (verified), and every
   * part here is numeric or an enum word.
   */
  private static mintCommentId(row: any) {
    return [
      String(row.comment_id),
      String(row.ad_id || ''),
      String(row.identity_type || ''),
      String(row.identity_id || ''),
    ].join(PART);
  }

  private static readCommentId(commentId: string) {
    const [id, adId, identityType, identityId] = String(commentId).split(PART);
    return {
      id,
      adId: adId || '',
      identityType: identityType || '',
      identityId: identityId || '',
    };
  }

  private normalizeComment(row: any): SocialComment {
    const status = row.comment_status
      ? String(row.comment_status).toUpperCase()
      : undefined;
    const createdAt = parseCreateTime(row.create_time);

    return {
      id: TiktokBusinessAdsProvider.mintCommentId(row),
      // The ads surface calls the body `content` (the organic one calls it
      // `text`) and the commenter `user_name`.
      text: row.content || '',
      username: row.user_name,
      timestamp: createdAt ? createdAt.toISOString() : undefined,
      likeCount: Number(row.likes ?? 0),
      hidden: status ? status !== 'PUBLIC' : undefined,
    };
  }

  async fetchComments(
    id: string,
    accessToken: string,
    postId: string,
    _integration: Integration,
    cursor?: string
  ): Promise<SocialCommentsPage> {
    const [adGroupId, itemId] = String(postId).split(PART);
    if (!adGroupId || !itemId) {
      throw new BadBody(
        'tiktok-business-ads',
        '{}',
        Buffer.from('{}'),
        'Unrecognised TikTok ad post id'
      );
    }

    const page = Math.max(Number(cursor) || 1, 1);
    const { rows, hasMore } = await this.comments(
      id,
      accessToken,
      adGroupId,
      page
    );

    // One ad group serves several videos; keep only this post's comments.
    const mine = rows.filter(
      (row: any) => String(row.tiktok_item_id || '') === itemId
    );

    // Both levels arrive in the same list (comment_type COMMENT | REPLY), so the
    // thread can be assembled here instead of calling /comment/reference/ per
    // comment the way the organic provider has to.
    const tops = mine.filter(
      (row: any) => String(row.comment_type || 'COMMENT') !== 'REPLY'
    );
    const repliesByParent = new Map<string, any[]>();
    for (const row of mine) {
      const parent = String(row.original_comment_id || '');
      if (String(row.comment_type || '') !== 'REPLY' || !parent || parent === '0') {
        continue;
      }
      repliesByParent.set(parent, [...(repliesByParent.get(parent) || []), row]);
    }

    return {
      comments: tops.map((row: any) => ({
        ...this.normalizeComment(row),
        replies: (repliesByParent.get(String(row.comment_id)) || []).map(
          (reply: any) => this.normalizeComment(reply)
        ),
      })),
      next: hasMore ? String(page + 1) : undefined,
    };
  }

  /**
   * Recovers the reply fields for a comment whose id predates them (or was
   * minted from a row where TikTok left them empty).
   */
  private async findCommentRow(
    advertiserId: string,
    accessToken: string,
    adGroupId: string,
    commentId: string
  ): Promise<any | undefined> {
    for (let page = 1; page <= REPLY_LOOKUP_MAX_PAGES; page++) {
      const { rows, hasMore } = await this.comments(
        advertiserId,
        accessToken,
        adGroupId,
        page
      );

      const found = rows.find(
        (row: any) => String(row.comment_id) === commentId
      );
      if (found || !hasMore) {
        return found;
      }
    }

    return undefined;
  }

  async replyToComment(
    id: string,
    postId: string,
    commentId: string,
    accessToken: string,
    message: string,
    _integration: Integration
  ): Promise<{ id: string }> {
    const [adGroupId, itemId] = String(postId).split(PART);
    const parsed = TiktokBusinessAdsProvider.readCommentId(commentId);

    let { adId, identityType, identityId } = parsed;

    if (!adId || !identityType || !identityId) {
      const row = await this.findCommentRow(
        id,
        accessToken,
        adGroupId,
        parsed.id
      );
      adId = adId || String(row?.ad_id || '');
      identityType = identityType || String(row?.identity_type || '');
      identityId = identityId || String(row?.identity_id || '');
    }

    if (!adId || !identityType || !identityId) {
      throw new BadBody(
        'tiktok-business-ads',
        '{}',
        Buffer.from('{}'),
        'TikTok did not return an ad identity for this comment, so it cannot be replied to. Ads built on uploaded creatives sometimes omit it.'
      );
    }

    const data = await this.call<any>('/comment/post/', accessToken, {
      method: 'POST',
      body: {
        advertiser_id: id,
        ad_id: adId,
        tiktok_item_id: itemId,
        comment_id: parsed.id,
        // Literal REPLY — NOT the row's comment_type. The row's enum is
        // {COMMENT, REPLY} while this field's is {POST, REPLY}, so echoing a
        // top-level row's "COMMENT" back is rejected every time.
        comment_type: 'REPLY',
        identity_type: identityType,
        identity_id: identityId,
        text: message,
      },
    });

    const replyId = data?.comment_id ?? data?.id;
    if (!replyId) {
      throw new BadBody(
        'tiktok-business-ads',
        JSON.stringify(data || {}),
        Buffer.from(JSON.stringify(data || {})),
        'TikTok Ads reply response is missing a comment id'
      );
    }

    return { id: String(replyId) };
  }

  async hideComment(
    id: string,
    _postId: string,
    commentId: string,
    accessToken: string,
    hidden: boolean,
    _integration: Integration
  ): Promise<{ id: string; hidden: boolean }> {
    const { id: bareId } = TiktokBusinessAdsProvider.readCommentId(commentId);

    // Batch endpoint, and the operation values are HIDDEN/PUBLIC — not the
    // HIDE/UNHIDE the organic /business/comment/hide/ takes. /comment/hide/
    // does not exist on this surface.
    await this.call<any>('/comment/status/update/', accessToken, {
      method: 'POST',
      body: {
        advertiser_id: id,
        comment_ids: [bareId],
        operation: hidden ? 'HIDDEN' : 'PUBLIC',
      },
    });

    return { id: commentId, hidden };
  }

  override handleErrors(body: string):
    | { type: 'refresh-token' | 'bad-body'; value: string }
    | undefined {
    if (
      body.indexOf('access_token') > -1 &&
      (body.indexOf('invalid') > -1 ||
        body.indexOf('empty') > -1 ||
        body.indexOf('expired') > -1)
    ) {
      return {
        type: 'refresh-token' as const,
        value:
          'TikTok Ads access token is invalid, please reconnect your ad account',
      };
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Marketing API call helper. Same HTTP-200-with-`code` contract as the tt_user
  // surface, so success cannot be read off the HTTP status.
  // ---------------------------------------------------------------------------
  private async call<T = any>(
    path: string,
    accessToken: string,
    options: {
      method?: 'GET' | 'POST';
      query?: Record<string, unknown>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    const method = options.method || 'GET';

    const qs = options.query
      ? '?' +
        new URLSearchParams(
          Object.entries(options.query).reduce((acc, [k, v]) => {
            if (v === undefined || v === null || v === '') return acc;
            acc[k] = Array.isArray(v) ? JSON.stringify(v) : String(v);
            return acc;
          }, {} as Record<string, string>)
        ).toString()
      : '';

    const response = await this.fetch(
      `${BASE}${path}${qs}`,
      {
        method,
        headers: {
          'Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      },
      'tiktok-business-ads'
    );

    // A wrong path answers plain-text "Not Found" and a wrong verb
    // "Method Not Allowed", both with no JSON — exactly what a mis-specified
    // endpoint on this surface produces. Report that instead of an opaque
    // parse error.
    const raw = await response.text();
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new BadBody(
        'tiktok-business-ads',
        raw,
        Buffer.from('{}'),
        `TikTok Ads API returned a non-JSON response for ${path}: ${raw.slice(
          0,
          200
        )}`
      );
    }

    const code = Number(json?.code ?? 0);
    if (code !== 0) {
      // Rate limits arrive as HTTP 200 with a code, so check before the token
      // codes — a throttled call must not be mistaken for a dead token and
      // trigger a pointless reconnect. integration.service.ts matches this
      // error by name to back off the crawl.
      if (isRateLimited(code, json?.message)) {
        throw new TiktokBusinessRateLimit(
          json?.message || 'TikTok Ads rate limit reached'
        );
      }

      if ([40001, 40104, 40105, 40110].includes(code)) {
        throw new RefreshToken(
          'tiktok-business-ads',
          JSON.stringify(json),
          Buffer.from(JSON.stringify(json)),
          json.message || 'TikTok Ads access token invalid'
        );
      }

      throw new BadBody(
        'tiktok-business-ads',
        JSON.stringify(json),
        Buffer.from(JSON.stringify(json)),
        json.message || 'TikTok Ads API error'
      );
    }

    return json.data as T;
  }
}
