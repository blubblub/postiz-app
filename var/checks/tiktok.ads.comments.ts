/**
 * Self-check for the TikTok Ads (advertiser surface) comment provider.
 *
 * The request and response shapes are pinned to the live advertiser API so a
 * future TikTok change fails here instead of silently emptying the comment screen.
 *
 *   npx tsx --tsconfig tsconfig.base.json var/checks/tiktok.ads.comments.ts
 */
import assert from 'node:assert';
import { TiktokBusinessAdsProvider } from '@gitroom/nestjs-libraries/integrations/social/tiktok.business.ads.provider';

type Call = { url: string; method: string; body?: any };

const ok = (data: any) => ({
  text: async () => JSON.stringify({ code: 0, message: 'OK', data }),
});

const row = (over: Record<string, any> = {}) => ({
  comment_id: 'c1',
  content: 'nice ad',
  user_name: 'someone',
  likes: 3,
  comment_type: 'COMMENT',
  original_comment_id: '0',
  comment_status: 'PUBLIC',
  ad_id: 'ad1',
  tiktok_item_id: 'item1',
  identity_id: 'ident1',
  identity_type: 'TT_USER',
  create_time: '2026-01-14 07:04:16 +0000 UTC',
  video_cover_url: 'https://cover/1.jpg',
  ad_text: 'Buy the thing',
  ...over,
});

const provider = () => {
  const calls: Call[] = [];
  const p: any = new TiktokBusinessAdsProvider();
  const routes: Record<string, any> = {};
  p.fetch = async (url: string, options: any = {}) => {
    calls.push({
      url,
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : undefined,
    });
    for (const [key, value] of Object.entries(routes)) {
      if (url.includes(key)) {
        return typeof value === 'function' ? value(url) : value;
      }
    }
    throw new Error('unstubbed ' + url);
  };
  return { p, calls, routes };
};

const q = (url: string, name: string) =>
  new URL(url).searchParams.get(name) || '';

(async () => {
  // ---- posts are derived by grouping comments on the item they were left on
  {
    const { p, calls, routes } = provider();
    routes['/adgroup/get/'] = ok({
      list: [
        { adgroup_id: 'ag1', adgroup_name: 'Group one', comment_disabled: false },
        { adgroup_id: 'ag2', adgroup_name: 'Muted', comment_disabled: true },
      ],
      page_info: { page: 1, total_page: 2 },
    });
    routes['/comment/list/'] = ok({
      comments: [
        row({ comment_id: 'c1', tiktok_item_id: 'item1' }),
        row({ comment_id: 'c2', tiktok_item_id: 'item1', create_time: '2026-03-01' }),
        row({ comment_id: 'c3', tiktok_item_id: 'item2' }),
      ],
      page_info: { page: 1, total_page: 1 },
    });

    const page = await p.fetchCommentPosts('adv1', 'tok', {} as any, 25);

    assert.deepStrictEqual(
      page.posts.map((post: any) => post.id),
      ['ag1:item1', 'ag1:item2'],
      'postId is <adgroup>:<item>, newest first'
    );
    assert.strictEqual(page.posts[0].commentCount, 2, 'comments counted per item');
    assert.strictEqual(page.posts[0].isAd, true, 'every post here is an ad');
    assert.strictEqual(page.posts[0].thumbnail, 'https://cover/1.jpg');
    assert.strictEqual(page.posts[0].content, 'Buy the thing');
    assert.strictEqual(page.next, '2', 'ad-group pages drive the cursor');

    const listed = calls.filter((c) => c.url.includes('/comment/list/'));
    assert.strictEqual(listed.length, 1, 'comment_disabled ad groups are skipped');
    assert.strictEqual(q(listed[0].url, 'search_field'), 'ADGROUP_ID',
      'ADGROUP_ID is the only filter this endpoint accepts');
    assert.strictEqual(q(listed[0].url, 'search_value'), 'ag1');
    assert.match(q(listed[0].url, 'start_time'), /^\d{4}-\d{2}-\d{2}$/,
      'start_time is a YYYY-MM-DD date, not an epoch');
    assert.strictEqual(
      (Date.parse(q(listed[0].url, 'end_time')) -
        Date.parse(q(listed[0].url, 'start_time'))) /
        (24 * 60 * 60 * 1000),
      29,
      'inclusive date bounds cover TikTok\'s maximum 30 calendar days'
    );
    assert.strictEqual(q(listed[0].url, 'comment_status'), '["ALL"]',
      'hidden comments must stay listed or they could never be unhidden');
  }

  // ---- comment lists stay sequential to respect TikTok's live QPS limit
  {
    const { p, routes } = provider();
    let inFlight = 0;
    let maxInFlight = 0;
    routes['/adgroup/get/'] = ok({
      list: [
        { adgroup_id: 'ag1', comment_disabled: false },
        { adgroup_id: 'ag2', comment_disabled: false },
      ],
      page_info: { page: 1, total_page: 1 },
    });
    routes['/comment/list/'] = async (url: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return ok({
        comments: [row({ tiktok_item_id: q(url, 'search_value') })],
        page_info: { page: 1, total_page: 1 },
      });
    };

    const page = await p.fetchCommentPosts('adv1', 'tok', {} as any, 25);
    assert.strictEqual(maxInFlight, 1, 'comment-list calls must not overlap');
    assert.strictEqual(page.posts.length, 2);
  }

  // ---- API failures surface instead of masquerading as an empty account
  {
    const { p, routes } = provider();
    routes['/adgroup/get/'] = ok({
      list: [{ adgroup_id: 'ag1', comment_disabled: false }],
      page_info: { page: 1, total_page: 1 },
    });
    routes['/comment/list/'] = {
      text: async () => JSON.stringify({
        code: 40002,
        message: 'The maximum allowed time span is 30 days.',
      }),
    };
    await assert.rejects(
      () => p.fetchCommentPosts('adv1', 'tok', {} as any, 25),
      /maximum allowed time span/,
      'TikTok errors must not render as a valid empty account'
    );
  }

  // ---- create_time: three documented formats and an epoch, none of them unix()
  {
    for (const [value, expected] of [
      ['2026-01-14 07:04:16 +0000 UTC', '2026-01-14T07:04:16.000Z'],
      ['2026-01-14 07:04:16', '2026-01-14T07:04:16.000Z'],
      ['2026-01-14', '2026-01-14T00:00:00.000Z'],
      ['1768374256', '2026-01-14T07:04:16.000Z'],
    ] as const) {
      const { p, routes } = provider();
      routes['/adgroup/get/'] = ok({
        list: [{ adgroup_id: 'ag1', comment_disabled: false }],
        page_info: { page: 1, total_page: 1 },
      });
      routes['/comment/list/'] = ok({
        comments: [row({ create_time: value })],
        page_info: { page: 1, total_page: 1 },
      });
      const page = await p.fetchCommentPosts('adv1', 'tok', {} as any, 25);
      assert.strictEqual(page.posts[0].publishDate, expected,
        `create_time ${value} must parse as UTC`);
    }
  }

  // ---- an unparseable date still yields a valid one, never "Invalid Date"
  {
    const { p, routes } = provider();
    routes['/adgroup/get/'] = ok({
      list: [{ adgroup_id: 'ag1', comment_disabled: false }],
      page_info: { page: 1, total_page: 1 },
    });
    routes['/comment/list/'] = ok({
      comments: [row({ create_time: 'not a date' })],
      page_info: { page: 1, total_page: 1 },
    });
    const page = await p.fetchCommentPosts('adv1', 'tok', {} as any, 25);
    assert.ok(!Number.isNaN(new Date(page.posts[0].publishDate).getTime()),
      'publishDate must always parse — the cache column is NOT NULL');
  }

  // ---- comments: filtered to the post, threaded from one list call
  {
    const { p, routes } = provider();
    routes['/comment/list/'] = ok({
      comments: [
        row({ comment_id: 'top1', tiktok_item_id: 'item1' }),
        row({ comment_id: 'rep1', tiktok_item_id: 'item1',
          comment_type: 'REPLY', original_comment_id: 'top1' }),
        row({ comment_id: 'other', tiktok_item_id: 'item2' }),
        row({ comment_id: 'hid1', tiktok_item_id: 'item1', comment_status: 'HIDDEN' }),
      ],
      page_info: { page: 1, total_page: 1 },
    });

    const page = await p.fetchComments('adv1', 'tok', 'ag1:item1', {} as any);
    assert.deepStrictEqual(
      page.comments.map((c: any) => c.id.split(':')[0]),
      ['top1', 'hid1'],
      'only this item, replies nested not listed'
    );
    assert.deepStrictEqual(
      page.comments[0].replies.map((r: any) => r.id.split(':')[0]),
      ['rep1'],
      'thread assembled without a /comment/reference/ call'
    );
    assert.strictEqual(page.comments[0].hidden, false);
    assert.strictEqual(page.comments[1].hidden, true, 'HIDDEN maps to hidden');
    assert.strictEqual(page.comments[0].text, 'nice ad', 'body field is `content`');
    assert.strictEqual(page.comments[0].username, 'someone', 'commenter is `user_name`');
  }

  // ---- reply: uses the ids baked into the comment id, no extra lookup
  {
    const { p, calls, routes } = provider();
    routes['/comment/post/'] = ok({ comment_id: 'new1' });

    const result = await p.replyToComment(
      'adv1', 'ag1:item1', 'c1:ad1:TT_USER:ident1', 'tok', 'thanks!', {} as any
    );

    assert.strictEqual(result.id, 'new1');
    assert.strictEqual(calls.length, 1, 'reply costs zero extra API calls');
    assert.deepStrictEqual(calls[0].body, {
      advertiser_id: 'adv1',
      ad_id: 'ad1',
      tiktok_item_id: 'item1',
      comment_id: 'c1',
      // The row's enum is {COMMENT,REPLY}; this field's is {POST,REPLY}, so
      // echoing a top-level row's value back is rejected every time.
      comment_type: 'REPLY',
      identity_type: 'TT_USER',
      identity_id: 'ident1',
      text: 'thanks!',
    });
  }

  // ---- reply: a bare comment id falls back to looking the row up
  {
    const { p, calls, routes } = provider();
    routes['/comment/list/'] = ok({
      comments: [row({ comment_id: 'c9', ad_id: 'adZ', identity_id: 'identZ' })],
      page_info: { page: 1, total_page: 1 },
    });
    routes['/comment/post/'] = ok({ comment_id: 'new2' });

    await p.replyToComment('adv1', 'ag1:item1', 'c9', 'tok', 'hi', {} as any);
    assert.strictEqual(calls.length, 2, 'one lookup, then the reply');
    assert.strictEqual(calls[1].body.ad_id, 'adZ');
    assert.strictEqual(calls[1].body.identity_id, 'identZ');
  }

  // ---- reply: no identity anywhere is a clear error, not a malformed request
  {
    const { p, routes } = provider();
    routes['/comment/list/'] = ok({ comments: [], page_info: { page: 1, total_page: 1 } });
    await assert.rejects(
      () => p.replyToComment('adv1', 'ag1:item1', 'c9', 'tok', 'hi', {} as any),
      /identity/i,
      'missing identity must explain itself'
    );
  }

  // ---- hide: HIDDEN/PUBLIC (not HIDE/UNHIDE), batch array, bare comment id
  {
    const { p, calls, routes } = provider();
    routes['/comment/status/update/'] = ok({});

    let r = await p.hideComment('adv1', 'ag1:item1', 'c1:ad1:TT_USER:ident1', 'tok', true, {} as any);
    assert.deepStrictEqual(calls[0].body, {
      advertiser_id: 'adv1',
      comment_ids: ['c1'],
      operation: 'HIDDEN',
    });
    assert.strictEqual(calls[0].method, 'POST');
    assert.strictEqual(r.hidden, true);
    assert.strictEqual(r.id, 'c1:ad1:TT_USER:ident1', 'echoes the id it was given');

    await p.hideComment('adv1', 'ag1:item1', 'c1', 'tok', false, {} as any);
    assert.strictEqual(calls[1].body.operation, 'PUBLIC');
  }

  // ---- a wrong path/verb answers plain text; say so instead of a parse error
  {
    const { p, routes } = provider();
    routes['/comment/status/update/'] = { text: async () => 'Not Found' };
    await assert.rejects(
      () => p.hideComment('adv1', 'p', 'c1', 'tok', true, {} as any),
      /non-JSON response/,
      'a 404/405 from this API is plain text, not JSON'
    );
  }

  // ---- this channel can never publish
  {
    const { p } = provider();
    assert.strictEqual(typeof (await p.checkValidity()), 'string',
      'composer validation must reject it');
    await assert.rejects(() => p.post('a', 'b', [], {} as any), /cannot publish/);
  }

  console.log('ALL CHECKS PASSED');
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
