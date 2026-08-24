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

// Graph returns cursors.after on the LAST page too, and only omits paging.next.
// `more` false models that, which is the case that decides whether "load more"
// ever stops.
const page = (data: any[], after?: string, more = true) => ({
  data,
  paging: after
    ? { ...(more ? { next: 'https://x' } : {}), cursors: { after } }
    : {},
});
const fbPost = (id: string, t: string) => ({
  id, message: 'm' + id, created_time: t, permalink_url: 'u' + id,
});

/**
 * A provider with its network stubbed. `routes` maps a URL substring to either a
 * JSON body or an Error to throw; `calls` records every URL requested, which is
 * how the checks assert WHICH token each call used.
 */
const provider = (Kind: any = FacebookProvider) => {
  const calls: string[] = [];
  const routes: Record<string, any> = {};
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
const stub = (routes: Record<string, any>) =>
  async function (url: string) {
    calls.push(url);
    for (const [key, value] of Object.entries(routes)) {
      if (url.includes(key)) {
        if (value instanceof Error) throw value;
        return { json: async () => value } as any;
      }
    }
    throw new Error('unstubbed ' + url);
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
    '?ids=ig_ad_4': { ig_ad_4: { id: 'ig_ad_4', caption: 'still here', timestamp: '2026-04-01T00:00:00+0000' } },
  });
  r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
  assert.deepStrictEqual(r.posts.map((p: any) => p.id), ['ig_ad_4'],
    'one unreadable ad account is skipped, and must not disconnect the channel');

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
  ig.fetch = async (url: string) => {
    if (url.includes('/media?')) return { json: async () => page([], undefined, false) } as any;
    if (url.includes('adaccounts')) return { json: async () => ({ data: [{ id: 'act_1' }] }) } as any;
    if (url.includes('act_1/ads'))
      return { json: async () => ({ data: many.map((m, i) => ({
        name: 'Ad ' + i, created_time: '2026-05-01T00:00:00+0000',
        creative: { effective_instagram_media_id: m } })) }) } as any;
    if (url.includes('?ids=')) {
      const ids = decodeURIComponent(url.split('?ids=')[1].split('&')[0]).split(',');
      batches.push(ids.length);
      return { json: async () => Object.fromEntries(ids.map((i) => [i,
        { id: i, caption: 'c', timestamp: '2026-05-01T00:00:00+0000' }])) } as any;
    }
    throw new Error('unstubbed ' + url);
  };
  r = await ig.fetchCommentPosts('IG', 'pageTok___userTok', {} as any, 30);
  assert.ok(batches.length > 1 && batches.every((n) => n <= 50),
    `?ids= must be chunked to <=50, got batches ${JSON.stringify(batches)}`);
  assert.strictEqual(r.posts.length, 120, 'every ad survives chunking');

  console.log('ALL CHECKS PASSED');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
