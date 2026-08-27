/**
 * Self-check for ad-post listing in the comment screen.
 *
 * Both Meta providers merge a Marketing API ad walk into their organic listing
 * and must degrade to organic-only when the ads permission is missing, without
 * ever reporting the channel's token as dead. That is worth pinning down, and
 * the repo has no test runner, so this is a plain assert script instead:
 *
 *   npx tsx --tsconfig tsconfig.base.json var/checks/comment.ad.posts.ts
 */
import assert from 'node:assert';
import { FacebookProvider } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { InstagramProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.provider';
import {
  BadBody,
  RefreshToken,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { MetaAdsCache } from '@gitroom/nestjs-libraries/integrations/social/meta.ads.cache';

// Graph returns cursors.after on the LAST page too, and only omits paging.next.
// `more` false models that, which is the case that decides whether "load more"
// ever stops.
const page = (data: any[], after?: string, more = true) => ({
  data,
  paging: after
    ? { ...(more ? { next: 'https://x' } : {}), cursors: { after } }
    : {},
});
// Ad posts with no comments are dropped from the listing, so fixtures that mean
// to assert an ad IS listed have to carry a count. `comments` defaults to 1 for
// that reason; pass 0 to model the empty ad that must be filtered out.
const fbPost = (id: string, t: string, comments = 1) => ({
  id, message: 'm' + id, created_time: t, permalink_url: 'u' + id,
  comments: { summary: { total_count: comments } },
});

// Both providers memoise the ad walk per channel so it can finish in the
// background, so every scenario below has to start from an empty cache or it
// asserts against the previous scenario's ads.
type Cache = { clear(): void; settle(): Promise<void> };
const adCache = (Kind: any) =>
  (Kind === FacebookProvider ? Kind.adPostsCache : Kind.adMediaCache) as Cache;
// Both the fast card cache and the slow walk cache behind it — leaving either
// warm makes a scenario assert against the previous one's ads.
const resetAdCaches = () => {
  for (const Kind of [FacebookProvider, InstagramProvider] as any[]) {
    adCache(Kind).clear();
    (Kind.adWalkCache as Cache).clear();
  }
};

/**
 * A provider with its network stubbed. `routes` maps a URL substring to either a
 * JSON body or an Error to throw; `calls` records every URL requested, which is
 * how the checks assert WHICH token each call used.
 */
const provider = (Kind: any = FacebookProvider) => {
  resetAdCaches();
  const calls: string[] = [];
  // Account discovery asks three edges; scenarios that don't care about
  // business-owned accounts still have to answer this one, because an
  // unanswered edge is now correctly reported as an incomplete walk.
  const routes: Record<string, any> = { 'me/businesses': { data: [] } };
  const p: any = new Kind();
  p.fetch = async (url: string) => {
    calls.push(url);
    for (const [key, value] of Object.entries(routes)) {
      if (url.includes(key)) {
        if (value instanceof Error) throw value;
        return { json: async () => value } as any;
      }
    }
    throw new Error('unstubbed ' + url);
  };
  return { p, calls, routes };
};

const calls: string[] = [];
const stub = (routes: Record<string, any>) => {
  resetAdCaches();
  const all = { 'me/businesses': { data: [] }, ...routes };
  return async function (url: string) {
    calls.push(url);
    for (const [key, value] of Object.entries(all)) {
      if (url.includes(key)) {
        if (value instanceof Error) throw value;
        return { json: async () => value } as any;
      }
    }
    throw new Error('unstubbed ' + url);
  };
};

(async () => {
  // ---- Facebook: ads come from the Marketing API and merge into the listing
  {
    const { p, calls, routes } = provider();
    routes['/posts?'] = page([fbPost('o1', '2026-01-02T00:00:00+0000')], 'ORG1');
    routes['adaccounts'] = { data: [{ id: 'act_1' }] };
    routes['act_1/ads'] = { data: [{ name: 'Ad one', created_time: '2026-01-03T00:00:00+0000',
      creative: { effective_object_story_id: 'P_dark1' } }] };
    routes['?ids=P_dark1'] = { P_dark1: fbPost('P_dark1', '2026-01-03T00:00:00+0000') };

    const r = await p.fetchCommentPosts('P', 'pagetok', { refreshToken: 'usertok' } as any, 30);
    assert.deepStrictEqual(r.posts.map((x: any) => x.id), ['P_dark1', 'o1'], 'ads merge, newest first');
    assert.strictEqual(r.posts[0].isAd, true);
    assert.strictEqual(r.posts[1].isAd, undefined);
    assert.strictEqual(r.posts[0].lastCommentDate, undefined,
      'Facebook cannot read a post\'s comments edge, so lastCommentDate stays absent');
    assert.strictEqual(r.next, 'ORG1', 'cursor is the plain /posts cursor');
    assert.ok(!calls.some((c) => c.includes('ads_posts')),
      'ads_posts needs pages_manage_ads and must not be called');
    assert.ok(calls.some((c) => c.includes('/me/adaccounts')), 'ads walk uses the user token');
    assert.ok(calls.find((c) => c.includes('adaccounts'))!.includes('usertok'),
      'ads walk must use the USER token, not the page token');
    assert.ok(calls.find((c) => c.includes('?ids='))!.includes('pagetok'),
      'reading the page post itself must use the PAGE token');
  }

  // ---- no user token (never reconnected) => organic only, no ads calls
  {
    const { p, calls, routes } = provider();
    routes['/posts?'] = page([fbPost('o2', '2026-01-01T00:00:00+0000')], undefined, false);
    const r = await p.fetchCommentPosts('P', 'pagetok', {} as any, 30);
    assert.deepStrictEqual(r.posts.map((x: any) => x.id), ['o2']);
    assert.ok(!calls.some((c) => c.includes('adaccounts')), 'no user token => no ads walk');
    assert.strictEqual(r.hasMore, false, 'cursors.after on the last page is not "more"');
  }

  // ---- ads permission missing => organic list survives
  {
    const { p, routes } = provider();
    routes['/posts?'] = page([fbPost('o3', '2026-01-01T00:00:00+0000')], undefined, false);
    routes['adaccounts'] = new BadBody('x', '{"error":{"code":200}}', '{}', '(#200) Not enough permission');
    const r = await p.fetchCommentPosts('P', 'pagetok', { refreshToken: 'usertok' } as any, 30);
    assert.deepStrictEqual(r.posts.map((x: any) => x.id), ['o3'], 'no ads_management => organic only');
  }

  // ---- a 490 inside an fbtrace_id must not be reported as a dead token
  {
    const { p, routes } = provider();
    routes['/posts?'] = page([fbPost('o4', '2026-01-01T00:00:00+0000')], undefined, false);
    routes['adaccounts'] = new RefreshToken('x', '{"error":{"fbtrace_id":"Ax490Qz"}}', '{}', 'expired');
    const r = await p.fetchCommentPosts('P', 'pagetok', { refreshToken: 'usertok' } as any, 30);
    assert.deepStrictEqual(r.posts.map((x: any) => x.id), ['o4']);
  }

  // ---- another Page's ads in the same ad account are excluded
  {
    const { p, routes } = provider();
    routes['/posts?'] = page([], undefined, false);
    routes['adaccounts'] = { data: [{ id: 'act_1' }] };
    routes['act_1/ads'] = { data: [
      { name: 'Ours', creative: { effective_object_story_id: 'P_mine' } },
      { name: 'Theirs', creative: { effective_object_story_id: 'OTHERPAGE_x' } },
    ] };
    routes['?ids=P_mine'] = { P_mine: fbPost('P_mine', '2026-02-01T00:00:00+0000') };
    const r = await p.fetchCommentPosts('P', 'pagetok', { refreshToken: 'usertok' } as any, 30);
    assert.deepStrictEqual(r.posts.map((x: any) => x.id), ['P_mine'],
      'story ids are <page>_<post>; other Pages must be filtered out');
  }

  // ---- a dark post that refuses a node read is still listed
  {
    const { p, routes } = provider();
    routes['/posts?'] = page([], undefined, false);
    routes['adaccounts'] = { data: [{ id: 'act_1' }] };
    routes['act_1/ads'] = { data: [{ name: 'Dark ad', created_time: '2026-05-01T00:00:00+0000',
      creative: { effective_object_story_id: 'P_dark2' } }] };
    routes['?ids=P_dark2'] = new BadBody('x', '{}', '{}', 'nope');
    const r = await p.fetchCommentPosts('P', 'pagetok', { refreshToken: 'usertok' } as any, 30);
    assert.deepStrictEqual(r.posts.map((x: any) => x.id), ['P_dark2'],
      'keep the post even when its node read fails — comments may still work');
    assert.strictEqual(r.posts[0].content, 'Dark ad');
  }

  // ---- Instagram: ad media merged in, standalone host never touches ads
  let r: any;
  const ig: any = new InstagramProvider();
  ig.fetch = stub({
    '/media?': page([{ id: 'm1', timestamp: '2026-01-01T00:00:00+0000', caption: 'organic' }], 'M1'),
    'adaccounts': { data: [{ id: 'act_1' }] },
    'act_1/ads': { data: [{ name: 'Ad one', created_time: '2026-02-01T00:00:00+0000',
      creative: { effective_instagram_media_id: 'ig_ad_1', instagram_permalink_url: 'https://ig/1' } }] },
    '?ids=ig_ad_1': { ig_ad_1: { id: 'ig_ad_1', caption: 'ad copy', timestamp: '2026-02-01T00:00:00+0000', comments_count: 7 } },
  });
  r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
  assert.deepStrictEqual(r.posts.map((p: any) => p.id), ['ig_ad_1', 'm1']);
  assert.strictEqual(r.posts[0].isAd, true);
  assert.strictEqual(r.posts[0].commentCount, 7, 'counts come from the media node');
  assert.strictEqual(r.posts[0].releaseURL, 'https://ig/1',
    'creative permalink survives a readable media node without its own permalink');
  assert.strictEqual(r.posts[1].isAd, undefined);

  // ---- lastCommentDate rides along in the media read, it is not a second round-trip
  {
    const seen: string[] = [];
    resetAdCaches();
    ig.fetch = async (url: string) => {
      seen.push(url);
      if (url.includes('/media?')) return { json: async () => page([{
        id: 'm_old', timestamp: '2026-08-01T00:00:00+0000', caption: 'old post',
        comments_count: 2,
        comments: { data: [{ timestamp: '2026-08-20T12:00:00+0000' }] },
      }]) } as any;
      if (url.includes('me/businesses')) return { json: async () => ({ data: [] }) } as any;
      if (url.includes('adaccounts')) return { json: async () => ({ data: [{ id: 'act_1' }] }) } as any;
      if (url.includes('act_1/ads')) return { json: async () => ({ data: [{
        name: 'Ad', created_time: '2026-08-10T00:00:00+0000',
        creative: { effective_instagram_media_id: 'ig_new' },
      }] }) } as any;
      if (url.includes('?ids=')) return { json: async () => ({
        ig_new: {
          id: 'ig_new', caption: 'ad', timestamp: '2026-08-10T00:00:00+0000',
          comments_count: 1,
          comments: { data: [{ timestamp: '2026-08-25T09:00:00+0000' }] },
        },
      }) } as any;
      throw new Error('unstubbed ' + url);
    };
    r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
    const decoded = seen.map((u) => decodeURIComponent(u));
    assert.ok(decoded.some((u) => u.includes('/media?') && u.includes('comments.limit(1)')),
      'organic media must ask for comments.limit(1) so lastCommentDate is free');
    assert.ok(decoded.some((u) => u.includes('?ids=') && u.includes('comments.limit(1)')),
      'the batched ad-media read must ask for it too');
    assert.strictEqual(r.posts.find((p: any) => p.id === 'm_old')?.lastCommentDate,
      '2026-08-20T12:00:00+0000');
    assert.strictEqual(r.posts.find((p: any) => p.id === 'ig_new')?.lastCommentDate,
      '2026-08-25T09:00:00+0000');
  }

  calls.length = 0;
  ig.fetch = stub({ '/media?': page([{ id: 'm2', timestamp: '2026-01-01T00:00:00+0000' }]) });
  r = await ig.fetchCommentPosts('IG', 'onlyPageTok', {} as any, 30, undefined, 'graph.instagram.com');
  assert.ok(!calls.some((c) => c.includes('adaccounts')), 'instagram-standalone never asks for ads');
  assert.strictEqual(r.posts.length, 1);

  // ---- ad media node unavailable: fall back to the ad's own card, keep the post
  ig.fetch = stub({
    '/media?': page([]),
    'adaccounts': { data: [{ id: 'act_1' }] },
    'act_1/ads': { data: [{ name: 'Ad two', created_time: '2026-03-01T00:00:00+0000',
      creative: { effective_instagram_media_id: 'ig_ad_2', instagram_permalink_url: 'https://ig/2' } }] },
    '?ids=ig_ad_2': new BadBody('x', '{}', '{}', 'nope'),
  });
  r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
  assert.deepStrictEqual(r.posts.map((p: any) => p.id), ['ig_ad_2'], 'ad survives a dead media node');
  assert.strictEqual(r.posts[0].content, 'Ad two');
  assert.strictEqual(r.posts[0].releaseURL, 'https://ig/2');

  // ---- one unreadable ad account does not take the others' ads down with it
  ig.fetch = stub({
    '/media?': page([]),
    'adaccounts': { data: [{ id: 'act_bad' }, { id: 'act_ok' }] },
    // subcode 33 is what Meta returns for an ad account you can list but not
    // read, and handleErrors classes it as an expired token — so this fixture
    // covers isolation AND the per-account catch swallowing RefreshToken.
    'act_bad/ads': new RefreshToken('x', '{"error":{"error_subcode":33}}', '{}', 'subcode 33'),
    'act_ok/ads': { data: [{ name: 'Ad three', created_time: '2026-04-01T00:00:00+0000',
      creative: { effective_instagram_media_id: 'ig_ad_4' } }] },
    '?ids=ig_ad_4': { ig_ad_4: { id: 'ig_ad_4', caption: 'still here', timestamp: '2026-04-01T00:00:00+0000', comments_count: 2 } },
  });
  r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
  assert.deepStrictEqual(r.posts.map((p: any) => p.id), ['ig_ad_4'],
    'one unreadable ad account is skipped, and must not disconnect the channel');

  // ---- a transient Unknown Error during the concurrent walk is retried
  {
    const { MetaAdsThrottle } = await import(
      '@gitroom/nestjs-libraries/integrations/social/meta.ads'
    );
    MetaAdsThrottle.backoffMs = 1;
    resetAdCaches();
    let adsCalls = 0;
    ig.fetch = async (url: string) => {
      if (url.includes('/media?')) return { json: async () => page([], undefined, false) } as any;
      if (url.includes('/me/adaccounts')) return { json: async () => ({ data: [{ id: 'act_flaky' }] }) } as any;
      if (url.includes('/me/businesses')) return { json: async () => ({ data: [] }) } as any;
      if (url.includes('act_flaky/ads')) {
        adsCalls++;
        if (adsCalls === 1) {
          throw Object.assign(new Error('Unknown Error'), {
            graphError: { message: 'Unknown Error' },
          });
        }
        return { json: async () => ({ data: [{ name: 'Recovered', created_time: '2026-08-01T00:00:00+0000',
          creative: { effective_instagram_media_id: 'ig_rec' } }] }) } as any;
      }
      if (url.includes('?ids=')) return { json: async () => ({
        ig_rec: { id: 'ig_rec', caption: 'back', timestamp: '2026-08-01T00:00:00+0000', comments_count: 1 },
      }) } as any;
      throw new Error('unstubbed ' + url);
    };
    r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
    assert.deepStrictEqual(r.posts.map((p: any) => p.id), ['ig_rec'],
      'an account that fails once in the concurrent walk is retried serially');
    assert.strictEqual(adsCalls, 2);
    assert.strictEqual(r.syncing, undefined,
      'a walk that recovered on retry is a complete answer');
  }

  // ---- creative belonging to a different IG account is filtered out
  ig.fetch = stub({
    '/media?': page([]),
    'adaccounts': { data: [{ id: 'act_1' }] },
    'act_1/ads': { data: [{ name: 'Other brand', creative: {
      effective_instagram_media_id: 'ig_ad_3', instagram_user_id: 'SOMEONE_ELSE' } }] },
  });
  r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
  assert.strictEqual(r.posts.length, 0, 'another account’s ad is excluded');

  ig.fetch = stub({
    '/media?': page([{ id: 'm3', timestamp: '2026-01-01T00:00:00+0000' }], undefined, false),
    'adaccounts': new RefreshToken('x', '{"error":{"error_subcode":33}}', '{}', 'subcode 33'),
  });
  r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
  assert.deepStrictEqual(r.posts.map((p: any) => p.id), ['m3'],
    'subcode 33 on an ad account must not disconnect the channel');

  // ---- more than 50 ad media ids: Graph caps ?ids= at 50, so it must chunk
  const many = Array.from({ length: 120 }, (_, i) => `ad_${i}`);
  const batches: number[] = [];
  resetAdCaches();
  ig.fetch = async (url: string) => {
    if (url.includes('/media?')) return { json: async () => page([], undefined, false) } as any;
    if (url.includes('me/businesses')) return { json: async () => ({ data: [] }) } as any;
    if (url.includes('adaccounts')) return { json: async () => ({ data: [{ id: 'act_1' }] }) } as any;
    if (url.includes('act_1/ads'))
      return { json: async () => ({ data: many.map((m, i) => ({
        name: 'Ad ' + i, created_time: '2026-05-01T00:00:00+0000',
        creative: { effective_instagram_media_id: m } })) }) } as any;
    if (url.includes('?ids=')) {
      const ids = decodeURIComponent(url.split('?ids=')[1].split('&')[0]).split(',');
      batches.push(ids.length);
      return { json: async () => Object.fromEntries(ids.map((i) => [i,
        { id: i, caption: 'c', timestamp: '2026-05-01T00:00:00+0000', comments_count: 1 }])) } as any;
    }
    throw new Error('unstubbed ' + url);
  };
  r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
  assert.ok(batches.length > 1 && batches.every((n) => n <= 50),
    `?ids= must be chunked to <=50, got batches ${JSON.stringify(batches)}`);
  assert.strictEqual(r.posts.length, 120, 'every ad survives chunking');

  // ---- READ EVERYTHING -------------------------------------------------
  // The two bugs below were live in production: ad accounts owned by a Business
  // Manager were never discovered, and only the first page of each account's
  // ads was read. Both were silent — the screen showed a short, arbitrary,
  // mostly-ancient slice and looked complete. These pin the fix.

  // ---- ad accounts owned by a business are discovered, not just /me/adaccounts
  {
    const seen: string[] = [];
    resetAdCaches();
    ig.fetch = async (url: string) => {
      seen.push(url);
      if (url.includes('/media?')) return { json: async () => page([], undefined, false) } as any;
      // The directly-assigned edge knows about ONE account...
      if (url.includes('/me/adaccounts')) return { json: async () => ({ data: [{ id: 'act_direct' }] }) } as any;
      if (url.includes('/me/businesses')) return { json: async () => ({ data: [{ id: 'biz_1' }] }) } as any;
      // ...while the business owns the account that is actually running ads.
      if (url.includes('biz_1/owned_ad_accounts')) return { json: async () => ({ data: [{ id: 'act_owned' }] }) } as any;
      if (url.includes('biz_1/client_ad_accounts')) return { json: async () => ({ data: [{ id: 'act_client' }] }) } as any;
      if (url.includes('act_direct/ads')) return { json: async () => ({ data: [] }) } as any;
      if (url.includes('act_owned/ads')) return { json: async () => ({ data: [{ name: 'Owned',
        created_time: '2026-08-01T00:00:00+0000', creative: { effective_instagram_media_id: 'ig_owned' } }] }) } as any;
      if (url.includes('act_client/ads')) return { json: async () => ({ data: [{ name: 'Client',
        created_time: '2026-08-02T00:00:00+0000', creative: { effective_instagram_media_id: 'ig_client' } }] }) } as any;
      if (url.includes('?ids=')) {
        const ids = decodeURIComponent(url.split('?ids=')[1].split('&')[0]).split(',');
        return { json: async () => Object.fromEntries(ids.map((i) => [i,
          { id: i, caption: i, timestamp: '2026-08-01T00:00:00+0000', comments_count: 1 }])) } as any;
      }
      throw new Error('unstubbed ' + url);
    };
    r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
    assert.ok(seen.some((u) => u.includes('/me/businesses')),
      'ad discovery must ask /me/businesses — /me/adaccounts omits business-owned accounts');
    assert.deepStrictEqual(r.posts.map((p: any) => p.id).sort(), ['ig_client', 'ig_owned'],
      'ads in business-owned AND client ad accounts must be listed');
  }

  // ---- an ad account that appears on two edges is only walked once
  {
    let adWalks = 0;
    resetAdCaches();
    ig.fetch = async (url: string) => {
      if (url.includes('/media?')) return { json: async () => page([], undefined, false) } as any;
      if (url.includes('/me/adaccounts')) return { json: async () => ({ data: [{ id: 'act_dup' }] }) } as any;
      if (url.includes('/me/businesses')) return { json: async () => ({ data: [{ id: 'biz_1' }] }) } as any;
      if (url.includes('owned_ad_accounts')) return { json: async () => ({ data: [{ id: 'act_dup' }] }) } as any;
      if (url.includes('client_ad_accounts')) return { json: async () => ({ data: [{ id: 'act_dup' }] }) } as any;
      if (url.includes('act_dup/ads')) { adWalks++; return { json: async () => ({ data: [] }) } as any; }
      throw new Error('unstubbed ' + url);
    };
    await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
    assert.strictEqual(adWalks, 1, 'an ad account listed on several edges is de-duplicated');
  }

  // ---- the /ads edge is paged to exhaustion, not read one page deep
  {
    const pagesServed: string[] = [];
    resetAdCaches();
    ig.fetch = async (url: string) => {
      if (url.includes('/media?')) return { json: async () => page([], undefined, false) } as any;
      if (url.includes('/me/adaccounts')) return { json: async () => ({ data: [{ id: 'act_1' }] }) } as any;
      if (url.includes('/me/businesses')) return { json: async () => ({ data: [] }) } as any;
      if (url.includes('/ads') || url.startsWith('https://next/')) {
        // Three pages. Only the LAST omits paging.next — and every page still
        // carries cursors.after, which is why termination cannot key off it.
        const which = url.startsWith('https://next/') ? url.split('/')[3] : '1';
        pagesServed.push(which);
        const id = `ig_p${which}`;
        const body: any = {
          data: [{ name: 'Ad ' + which, created_time: '2026-0' + which + '-01T00:00:00+0000',
            creative: { effective_instagram_media_id: id } }],
          paging: { cursors: { after: 'cur' + which } },
        };
        if (which !== '3') body.paging.next = `https://next/${Number(which) + 1}/ads`;
        return { json: async () => body } as any;
      }
      if (url.includes('?ids=')) {
        const ids = decodeURIComponent(url.split('?ids=')[1].split('&')[0]).split(',');
        return { json: async () => Object.fromEntries(ids.map((i) => [i,
          { id: i, caption: i, timestamp: '2026-01-01T00:00:00+0000', comments_count: 1 }])) } as any;
      }
      throw new Error('unstubbed ' + url);
    };
    r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
    assert.deepStrictEqual(pagesServed, ['1', '2', '3'], 'every page of the /ads edge is followed');
    assert.deepStrictEqual(r.posts.map((p: any) => p.id).sort(), ['ig_p1', 'ig_p2', 'ig_p3'],
      'ads beyond the first page must appear — the old code stopped at page 1');
  }

  // ---- "reduce the amount of data" backs the page size off instead of losing the account
  {
    const limits: number[] = [];
    resetAdCaches();
    ig.fetch = async (url: string) => {
      if (url.includes('/media?')) return { json: async () => page([], undefined, false) } as any;
      if (url.includes('/me/adaccounts')) return { json: async () => ({ data: [{ id: 'act_big' }] }) } as any;
      if (url.includes('/me/businesses')) return { json: async () => ({ data: [] }) } as any;
      if (url.includes('act_big/ads')) {
        const limit = Number(new URL(url).searchParams.get('limit'));
        limits.push(limit);
        // Graph refuses anything above 100 for this account, as one live
        // account did. Note this is an in-body error, not a throw.
        if (limit > 100) return { json: async () => ({ error: { code: 1,
          message: 'Please reduce the amount of data you\'re asking for, then retry your request' } }) } as any;
        return { json: async () => ({ data: [{ name: 'Big', created_time: '2026-07-01T00:00:00+0000',
          creative: { effective_instagram_media_id: 'ig_big' } }] }) } as any;
      }
      if (url.includes('?ids=')) {
        const ids = decodeURIComponent(url.split('?ids=')[1].split('&')[0]).split(',');
        return { json: async () => Object.fromEntries(ids.map((i) => [i,
          { id: i, caption: i, timestamp: '2026-07-01T00:00:00+0000', comments_count: 1 }])) } as any;
      }
      throw new Error('unstubbed ' + url);
    };
    r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
    assert.ok(limits.length > 1 && limits[limits.length - 1] <= 100,
      `page size must back off on "reduce the amount of data", tried ${JSON.stringify(limits)}`);
    assert.deepStrictEqual(r.posts.map((p: any) => p.id), ['ig_big'],
      'the account is still read after backing off, not dropped');
  }

  // ---- a partial walk is REPORTED, never passed off as complete
  {
    const { fetchMetaAds } = await import(
      '@gitroom/nestjs-libraries/integrations/social/meta.ads'
    );
    const res = await fetchMetaAds('tok', ['effective_instagram_media_id'], async (url: string) => {
      if (url.includes('/me/adaccounts')) return { json: async () => ({ data: [{ id: 'act_ok' }, { id: 'act_no' }] }) } as any;
      if (url.includes('/me/businesses')) return { json: async () => ({ data: [] }) } as any;
      if (url.includes('act_ok/ads')) return { json: async () => ({ data: [{ name: 'ok' }] }) } as any;
      throw new Error('nope');
    });
    assert.strictEqual(res.ads.length, 1);
    assert.deepStrictEqual(res.unreadable.map((u: any) => u.id), ['act_no'],
      'an account that could not be read is named, so a partial answer cannot look complete');
    assert.strictEqual(res.accounts.length, 2, 'every discovered account is reported');
  }

  // ---- a business edge that fails is REPORTED, not silently treated as empty
  // Two consecutive live runs found 49 and 35 ad accounts while reporting no
  // problem at all, because a throttled business edge returned []. A short
  // account list produces no ads and no error — indistinguishable from an
  // advertiser who simply isn't running any.
  {
    const { fetchMetaAds } = await import(
      '@gitroom/nestjs-libraries/integrations/social/meta.ads'
    );
    const res = await fetchMetaAds('tok', ['effective_instagram_media_id'], async (url: string) => {
      if (url.includes('/me/adaccounts')) return { json: async () => ({ data: [{ id: 'act_direct' }] }) } as any;
      if (url.includes('/me/businesses')) return { json: async () => ({ data: [{ id: 'biz_1' }] }) } as any;
      if (url.includes('biz_1/owned_ad_accounts'))
        return { json: async () => ({ error: { code: 200, message: 'no business_management' } }) } as any;
      if (url.includes('biz_1/client_ad_accounts')) return { json: async () => ({ data: [] }) } as any;
      return { json: async () => ({ data: [] }) } as any;
    });

    assert.deepStrictEqual(res.accounts.map((a: any) => a.id), ['act_direct'],
      'the readable edges still contribute their accounts');
    assert.deepStrictEqual(res.unreadable.map((u: any) => u.id), ['biz_1/owned_ad_accounts'],
      'an unlistable business edge must be named — it means the account list is short');
  }

  // ---- a throttled edge is retried, so a whole business is not lost to a blip
  {
    const { fetchMetaAdAccounts, MetaAdsThrottle } = await import(
      '@gitroom/nestjs-libraries/integrations/social/meta.ads'
    );
    MetaAdsThrottle.backoffMs = 1;
    let attempts = 0;
    const discovery = await fetchMetaAdAccounts('tok', async (url: string) => {
      if (url.includes('/me/businesses')) return { json: async () => ({ data: [] }) } as any;
      if (url.includes('/me/adaccounts')) {
        attempts++;
        if (attempts === 1)
          return { json: async () => ({ error: { code: 613,
            message: 'There have been too many calls to this ad-account.' } }) } as any;
        return { json: async () => ({ data: [{ id: 'act_1' }] }) } as any;
      }
      throw new Error('unstubbed ' + url);
    });

    assert.strictEqual(attempts, 2, 'a throttled edge is retried, not written off');
    assert.deepStrictEqual(discovery.accounts.map((a: any) => a.id), ['act_1']);
    assert.deepStrictEqual(discovery.failed, [], 'a retry that succeeds is not a failure');
  }

  // ---- the walk is bounded by ad creation date, and says so
  // Ads are never deleted, so unbounded means 54,201 ads / 24,875 media / 5.4
  // minutes on the live account (measured). A year's window is 2,752 ads in
  // 61s and still contains today's ads. The bound must stay on the request —
  // `sort` and `date_preset` are ignored on this edge, so nothing else works —
  // and must be reported, which is what separates it from a silent cap.
  {
    const { fetchMetaAds } = await import(
      '@gitroom/nestjs-libraries/integrations/social/meta.ads'
    );
    const seen: string[] = [];
    const res = await fetchMetaAds('tok', ['effective_instagram_media_id'], async (url: string) => {
      seen.push(url);
      if (url.includes('/me/adaccounts')) return { json: async () => ({ data: [{ id: 'act_1' }] }) } as any;
      if (url.includes('/me/businesses')) return { json: async () => ({ data: [] }) } as any;
      return { json: async () => ({ data: [] }) } as any;
    });

    const adsCall = seen.find((u) => u.includes('act_1/ads'))!;
    const filtering = JSON.parse(
      decodeURIComponent(new URL(adsCall).searchParams.get('filtering') || '[]')
    );
    assert.deepStrictEqual(filtering, [
      { field: 'ad.created_time', operator: 'GREATER_THAN', value: res.since },
    ], 'the /ads walk must carry its date bound as a filter, and report the same bound');

    const days = (Date.now() / 1000 - res.since) / 86400;
    assert.ok(days > 350 && days < 380, `expected a ~1 year window, got ${days} days`);
  }

  // ---- Meta's several spellings of "slow down" are all treated as throttling
  {
    const { isRateLimit } = await import(
      '@gitroom/nestjs-libraries/integrations/social/meta.ads'
    );
    // The live message, which carries no distinctive code of its own.
    assert.ok(isRateLimit(new Error(
      'There have been too many calls to this ad-account. Wait a bit and try again.')),
      'the ads-account throttle must be recognised — it is the one actually seen in production');
    assert.ok(isRateLimit(Object.assign(new Error('x'), { graphError: { code: 17 } })));
    assert.ok(isRateLimit(Object.assign(new Error('x'), { graphError: { code: 4 } })));
    assert.ok(!isRateLimit(new Error(
      'Please reduce the amount of data you\'re asking for, then retry your request')),
      'an oversized request is not a rate limit — it must halve the page size instead of sleeping');
    assert.ok(!isRateLimit(Object.assign(new Error(
      'Please reduce the amount of data you\'re asking for, then retry your request'),
      { graphError: { code: 1 } })),
      'code 1 plus reduce-data is still a page-size problem, not a wait');
    assert.ok(!isRateLimit(Object.assign(new Error('nope'), { graphError: { code: 200 } })),
      'a permission error must not be retried as throttling');
    assert.ok(isRateLimit(new Error('Unknown Error')),
      'Graph\'s generic Unknown Error is how a busy ad account answers');
    assert.ok(isRateLimit(Object.assign(new Error('x'), {
      graphError: { code: 1, message: 'Unknown Error' },
    })));
    assert.ok(isRateLimit(Object.assign(new Error('x'), { graphError: { code: 2 } })),
      'code 2 is a temporary service error and must be waited out');
    assert.ok(isRateLimit({
      message: 'Unknown Error',
      details: [{ json: '{"error":{"code":1,"message":"Unknown Error"}}' }],
    }), 'BadBody from fetch() carries the Graph JSON in details, not graphError');
  }

  // ---- Unknown Error on /ads is retried like a throttle, not written off
  {
    const { fetchMetaAds, MetaAdsThrottle } = await import(
      '@gitroom/nestjs-libraries/integrations/social/meta.ads'
    );
    MetaAdsThrottle.backoffMs = 1;
    let attempts = 0;
    const res = await fetchMetaAds(
      'tok',
      ['effective_instagram_media_id'],
      async (url: string) => {
        if (url.includes('/me/adaccounts'))
          return { json: async () => ({ data: [{ id: 'act_1' }] }) } as any;
        if (url.includes('/me/businesses'))
          return { json: async () => ({ data: [] }) } as any;
        if (url.includes('act_1/ads')) {
          attempts++;
          if (attempts === 1) {
            throw Object.assign(new Error('Unknown Error'), {
              details: [{ json: '{"error":{"code":1,"message":"Unknown Error"}}' }],
            });
          }
          return { json: async () => ({ data: [{
            name: 'Recovered', created_time: '2026-08-01T00:00:00+0000',
            creative: { effective_instagram_media_id: 'ig_rec' },
          }] }) } as any;
        }
        throw new Error('unstubbed ' + url);
      }
    );
    assert.strictEqual(attempts, 2,
      'Unknown Error must be retried on the same account, not recorded as unreadable');
    assert.deepStrictEqual(res.unreadable, []);
    assert.strictEqual(res.ads.length, 1);
  }

  // ---- THE WALK OUTLIVES THE SCREEN LOAD -------------------------------
  // Reading every ad account to exhaustion takes 11-30s on a large business —
  // far more than a screen load can wait for. It finishes in the background and
  // fills a cache. What must never happen is the wait expiring and turning "we
  // read everything" back into a silent, complete-looking "there are no ads".
  {
    resetAdCaches();
    const slowCache = new MetaAdsCache<any[]>(60_000, 20);
    const installed = (InstagramProvider as any).adMediaCache;
    (InstagramProvider as any).adMediaCache = slowCache;

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let adWalks = 0;

    ig.fetch = async (url: string) => {
      if (url.includes('/media?')) return { json: async () => page(
        [{ id: 'organic', timestamp: '2026-08-01T00:00:00+0000' }], undefined, false) } as any;
      if (url.includes('/me/adaccounts')) return { json: async () => ({ data: [{ id: 'act_slow' }] }) } as any;
      if (url.includes('/me/businesses')) return { json: async () => ({ data: [] }) } as any;
      if (url.includes('act_slow/ads')) {
        adWalks++;
        await held;
        return { json: async () => ({ data: [{ name: 'Slow ad', created_time: '2026-08-20T00:00:00+0000',
          creative: { effective_instagram_media_id: 'ig_slow' } }] }) } as any;
      }
      if (url.includes('?ids=')) {
        const ids = decodeURIComponent(url.split('?ids=')[1].split('&')[0]).split(',');
        return { json: async () => Object.fromEntries(ids.map((i) => [i,
          { id: i, caption: i, timestamp: '2026-08-20T00:00:00+0000', comments_count: 1 }])) } as any;
      }
      throw new Error('unstubbed ' + url);
    };

    r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
    assert.deepStrictEqual(r.posts.map((p: any) => p.id), ['organic'],
      'a walk slower than the wait must neither block the screen nor fail it');
    assert.strictEqual(r.syncing, true,
      'an unfinished walk must be reported — an ad-less list otherwise reads as "no ads"');

    r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
    assert.strictEqual(adWalks, 1, 'a second load joins the running walk instead of starting another');

    release();
    await slowCache.settle();

    r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
    assert.deepStrictEqual(r.posts.map((p: any) => p.id), ['ig_slow', 'organic'],
      'the background walk fills the cache, so the next load carries every ad');
    assert.strictEqual(r.syncing, undefined, 'a cached walk is a complete answer');
    assert.strictEqual(adWalks, 1, 'a cached walk is not repeated');

    (InstagramProvider as any).adMediaCache = installed;
  }

  // ---- an ad nobody has commented on is not listed, but an unreadable one is
  // 3,108 ad cards on the live account, ~240 with any comment. This is a
  // comment screen; the other 2,870 bury the ones that can be acted on.
  {
    resetAdCaches();
    ig.fetch = async (url: string) => {
      if (url.includes('/media?')) return { json: async () => page([], undefined, false) } as any;
      if (url.includes('/me/adaccounts')) return { json: async () => ({ data: [{ id: 'act_1' }] }) } as any;
      if (url.includes('/me/businesses')) return { json: async () => ({ data: [] }) } as any;
      if (url.includes('act_1/ads')) return { json: async () => ({ data: [
        { name: 'Talked about', created_time: '2026-08-01T00:00:00+0000',
          creative: { effective_instagram_media_id: 'ig_busy' } },
        { name: 'Ignored', created_time: '2026-08-02T00:00:00+0000',
          creative: { effective_instagram_media_id: 'ig_quiet' } },
        { name: 'Unreadable', created_time: '2026-08-03T00:00:00+0000',
          creative: { effective_instagram_media_id: 'ig_gone' } },
      ] }) } as any;
      if (url.includes('?ids=')) return { json: async () => ({
        ig_busy: { id: 'ig_busy', caption: 'busy', timestamp: '2026-08-01T00:00:00+0000', comments_count: 3 },
        ig_quiet: { id: 'ig_quiet', caption: 'quiet', timestamp: '2026-08-02T00:00:00+0000', comments_count: 0 },
        // ig_gone is simply absent, as Graph does for media it won't return.
      }) } as any;
      throw new Error('unstubbed ' + url);
    };
    r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
    assert.deepStrictEqual(r.posts.map((p: any) => p.id).sort(), ['ig_busy', 'ig_gone'],
      'an ad with zero comments is dropped; one whose count is UNKNOWN is kept');
  }

  // ---- comment counts refresh without repeating the expensive account walk
  // The walk is ~110 requests and 60s, so it is cached for an hour; the counts
  // are what a moderator is watching, so they are not.
  {
    resetAdCaches();
    let walks = 0;
    let mediaReads = 0;
    let comments = 0;
    ig.fetch = async (url: string) => {
      if (url.includes('/media?')) return { json: async () => page([], undefined, false) } as any;
      if (url.includes('/me/adaccounts')) return { json: async () => ({ data: [{ id: 'act_1' }] }) } as any;
      if (url.includes('/me/businesses')) return { json: async () => ({ data: [] }) } as any;
      if (url.includes('act_1/ads')) {
        walks++;
        return { json: async () => ({ data: [{ name: 'Ad', created_time: '2026-08-01T00:00:00+0000',
          creative: { effective_instagram_media_id: 'ig_1' } }] }) } as any;
      }
      if (url.includes('?ids=')) {
        mediaReads++;
        return { json: async () => ({ ig_1: { id: 'ig_1', caption: 'c',
          timestamp: '2026-08-01T00:00:00+0000', comments_count: comments } }) } as any;
      }
      throw new Error('unstubbed ' + url);
    };

    r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
    assert.strictEqual(r.posts.length, 0, 'no comments yet, so no card');

    // A comment arrives. Expire only the fast cache, as 15 minutes would.
    comments = 1;
    (InstagramProvider as any).adMediaCache.clear();

    r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
    assert.deepStrictEqual(r.posts.map((p: any) => p.id), ['ig_1'],
      'the ad appears as soon as it is commented on');
    assert.strictEqual(r.posts[0].commentCount, 1);
    assert.strictEqual(walks, 1,
      'the hour-long account walk is NOT repeated to refresh a comment count');
    assert.strictEqual(mediaReads, 2, 'the cheap media read is what refreshes');
  }

  // ---- a failed walk must not erase the ads a good one already found
  {
    // ttl 0 so every read refreshes, which is what makes the failure visible.
    const cache = new MetaAdsCache<string[]>(0, 100, 60_000);
    let attempts = 0;
    let broken = false;
    const load = async () => {
      attempts++;
      if (broken) throw new Error('ad account went away');
      return ['ad_1'];
    };

    assert.deepStrictEqual((await cache.read('k', load)).value, ['ad_1']);

    broken = true;
    const afterFailure = await cache.read('k', load);
    assert.deepStrictEqual(afterFailure.value, ['ad_1'],
      'one failed walk must not make the ads look deleted');
    assert.strictEqual(afterFailure.complete, true);

    await cache.settle();
    const attemptsBefore = attempts;
    await cache.read('k', load);
    assert.strictEqual(attempts, attemptsBefore,
      'a failed walk cools down instead of being restarted by every screen load');
  }

  // ---- an incomplete walk is not frozen for the full TTL, and must not
  // replace a complete one. This is how 114 of 239 Instagram ads stayed
  // missing for an hour after three accounts returned Unknown Error.
  {
    type Walk = { ads: string[]; unreadable: string[] };
    const cache = new MetaAdsCache<Walk>(
      60_000, 100, 0, 100, (walk) => walk.unreadable.length === 0
    );
    let n = 0;
    const load = async (): Promise<Walk> => {
      n++;
      return n === 1
        ? { ads: ['a'], unreadable: ['act_bad'] }
        : { ads: ['a', 'b'], unreadable: [] };
    };

    assert.deepStrictEqual((await cache.readBlocking('k', load)).value?.ads, ['a']);
    assert.strictEqual(n, 1);
    const second = await cache.readBlocking('k', load);
    assert.deepStrictEqual(second.value?.ads, ['a', 'b'],
      'the next load retries instead of serving the short list for the full TTL');
    assert.strictEqual(n, 2);
    await cache.readBlocking('k', load);
    assert.strictEqual(n, 2, 'a complete walk is then held');
  }

  {
    type Walk = { ads: string[]; unreadable: string[] };
    const cache = new MetaAdsCache<Walk>(
      0, 100, 60_000, 100, (walk) => walk.unreadable.length === 0
    );
    let n = 0;
    const load = async (): Promise<Walk> => {
      n++;
      return n === 1
        ? { ads: ['full'], unreadable: [] }
        : { ads: ['partial'], unreadable: ['act_bad'] };
    };

    assert.deepStrictEqual((await cache.readBlocking('k', load)).value?.ads, ['full']);
    assert.deepStrictEqual((await cache.readBlocking('k', load)).value?.ads, ['full'],
      'an incomplete walk must not replace ads a complete one already found');
    assert.strictEqual(n, 2);
    const before = n;
    await cache.readBlocking('k', load);
    assert.strictEqual(n, before,
      'refusing to overwrite a complete walk cools down like a thrown one');
  }

  console.log('ALL CHECKS PASSED');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
