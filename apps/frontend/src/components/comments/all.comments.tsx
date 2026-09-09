"use client";

import useSWR from 'swr';
import { type UIEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { orderBy } from 'lodash';
import { useRouter } from 'next/navigation';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import ImageWithFallback from '@gitroom/react/helpers/image.with.fallback';
import {
  type AllComment,
  type CommentChannel,
  CommentThread,
  formatDate,
} from '@gitroom/frontend/components/comments/social.comments';

type OrgComment = AllComment & { integration: CommentChannel };

type OrgChannel = CommentChannel & {
  posts: number;
  unreadable: number;
  syncing?: boolean;
  error?: string;
};

type OrgCommentsResponse = {
  comments: OrgComment[];
  channels: OrgChannel[];
  hasMore: boolean;
  next?: string;
  cachedAt?: string;
};

const PAGE = 10;

const byNewest = (list: OrgComment[]) =>
  orderBy(
    list,
    [(comment) => Date.parse(comment.timestamp || '') || 0],
    ['desc']
  );

const shouldLoadMore = (element: HTMLElement) =>
  element.scrollHeight - element.scrollTop - element.clientHeight < 160;

const empty: OrgCommentsResponse = { comments: [], channels: [], hasMore: false };

/**
 * Every channel's comments on one timeline, newest first. Each card names its
 * channel (platform icon + name) and opens to show the post it sits on, with a
 * link to the post itself and to that channel's comment screen.
 *
 * The backend holds the feed for a few minutes per organization because each
 * load is a burst of platform requests across every channel; "Refresh" is the
 * explicit way to pay for a fresh read.
 */
export const AllComments = () => {
  const fetch = useFetch();
  const t = useT();
  const router = useRouter();
  const [comments, setComments] = useState<OrgComment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    return (await (
      await fetch(`/integrations/comments/all?limit=${PAGE}`)
    ).json()) as OrgCommentsResponse;
  }, [fetch]);

  const { data, error, isLoading, mutate } = useSWR<OrgCommentsResponse>(
    'org-comments-feed',
    load,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      fallbackData: empty,
    }
  );

  useEffect(() => {
    setComments(data?.comments || []);
    setNextCursor(data?.next);
  }, [data]);

  const refresh = useCallback(async () => {
    if (refreshing) {
      return;
    }
    setRefreshing(true);
    try {
      const fresh = (await (
        await fetch(`/integrations/comments/all?limit=${PAGE}&refresh=1`)
      ).json()) as OrgCommentsResponse;
      await mutate(fresh, { revalidate: false });
    } finally {
      setRefreshing(false);
    }
  }, [fetch, mutate, refreshing]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) {
      return;
    }
    setLoadingMore(true);
    try {
      const response = (await (
        await fetch(
          `/integrations/comments/all?limit=${PAGE}&after=${encodeURIComponent(
            nextCursor
          )}`
        )
      ).json()) as OrgCommentsResponse;
      setComments((current) => {
        const seen = new Set(
          current.map((comment) => `${comment.integration.id}:${comment.id}`)
        );
        return byNewest([
          ...current,
          ...(response.comments || []).filter(
            (comment) => !seen.has(`${comment.integration.id}:${comment.id}`)
          ),
        ]);
      });
      setNextCursor(response.next);
    } finally {
      setLoadingMore(false);
    }
  }, [fetch, loadingMore, nextCursor]);

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (shouldLoadMore(event.currentTarget)) {
        loadMore();
      }
    },
    [loadMore]
  );

  const act = useCallback(
    async (
      comment: OrgComment,
      action: 'replies' | 'hide',
      body: Record<string, unknown>
    ) => {
      const response = await fetch(
        `/integrations/comments/${comment.integration.id}/posts/${comment.post.id}/${action}`,
        { method: 'POST', body: JSON.stringify(body) }
      );
      if (!response.ok) {
        throw new Error('Request failed');
      }
      // The server-side feed cache is now stale by one comment; re-read it.
      await refresh();
    },
    [fetch, refresh]
  );

  const channels = data?.channels || [];
  const failing = useMemo(
    () => channels.filter((channel) => channel.error),
    [channels]
  );
  const partial = useMemo(
    () => channels.reduce((sum, channel) => sum + channel.unreadable, 0),
    [channels]
  );
  const syncing = useMemo(
    () => channels.some((channel) => channel.syncing),
    [channels]
  );

  return (
    <div className="flex flex-1 flex-col gap-[16px] bg-newBgColorInner p-[20px]">
      <div className="flex min-h-0 flex-1 flex-col rounded-[8px] border border-tableBorder bg-newBgColor p-[16px]">
        <div className="mb-[14px] flex items-start justify-between gap-[12px]">
          <div className="min-w-0">
            <div className="text-[20px] font-[600]">
              {t('all_comments', 'All comments')}
            </div>
            <div className="text-[13px] text-textColor/60">
              {t('org_comments_help', 'Every channel, newest first.')}{' '}
              {!!data?.cachedAt &&
                t('org_comments_cached', {
                  defaultValue: 'As of {{time}}.',
                  time: formatDate(data.cachedAt),
                })}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-[10px] text-[13px]">
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing || isLoading}
              className="rounded-[6px] border border-tableBorder bg-newBgColorInner px-[10px] py-[5px] font-[500] text-textColor hover:bg-boxHover disabled:opacity-50"
            >
              {refreshing
                ? t('refreshing', 'Refreshing...')
                : t('refresh', 'Refresh')}
            </button>
            <button
              type="button"
              onClick={() => router.push('/comments')}
              className="text-forth hover:underline"
            >
              {t('browse_by_channel', 'Browse by channel')}
            </button>
          </div>
        </div>
        {!!channels.length && (
          <div className="mb-[12px] flex flex-wrap items-center gap-[8px]">
            {channels.map((channel) => (
              <div
                key={channel.id}
                title={
                  channel.error
                    ? channel.error
                    : `${channel.posts} ${t('posts_read', 'posts read')}`
                }
                className={
                  'flex items-center gap-[6px] rounded-[6px] border px-[8px] py-[4px] text-[12px] ' +
                  (channel.error
                    ? 'border-red-500/40 bg-red-500/10 text-red-300'
                    : 'border-tableBorder bg-newBgColorInner text-textColor/70')
                }
              >
                <ImageWithFallback
                  fallbackSrc={`/icons/platforms/${channel.identifier}.png`}
                  src={channel.picture || `/icons/platforms/${channel.identifier}.png`}
                  className="rounded-[3px]"
                  alt={channel.identifier}
                  width={14}
                  height={14}
                />
                <span className="max-w-[160px] truncate">{channel.name}</span>
                {channel.error && <span>!</span>}
              </div>
            ))}
          </div>
        )}
        {(isLoading || refreshing) && (
          <div className="mb-[12px] flex items-center gap-[10px] text-[13px] text-textColor/60">
            <div className="h-[14px] w-[14px] shrink-0 animate-spin rounded-full border-[2px] border-textColor/30 border-t-textColor" />
            {t(
              'org_comments_loading',
              'Reading comments from every channel. This can take a minute.'
            )}
          </div>
        )}
        {!!error && (
          <div className="mb-[12px] rounded-[8px] bg-red-500/10 p-[12px] text-[14px] text-red-300">
            {t('could_not_load_comments', 'Could not load comments')}
          </div>
        )}
        {!isLoading && (!!failing.length || partial > 0) && (
          <div className="mb-[12px] rounded-[8px] border border-amber-500/30 bg-amber-500/10 p-[12px] text-[13px] text-textColor/80">
            {!!failing.length &&
              t('org_comments_failing', {
                defaultValue:
                  '{{count}} channels could not be read, their comments are missing.',
                count: failing.length,
              })}{' '}
            {partial > 0 &&
              t('all_comments_partial', {
                defaultValue:
                  'Comments from {{count}} posts could not be loaded, so this feed is incomplete.',
                count: partial,
              })}
          </div>
        )}
        {!isLoading && !error && !comments.length && (
          <div className="rounded-[8px] bg-third p-[14px] text-[14px] text-textColor/70">
            {syncing
              ? t(
                  'syncing_posts',
                  'Syncing posts from the channel. The first sync walks back through the whole history and can take a few minutes.'
                )
              : t('no_comments_yet', 'No comments yet.')}
          </div>
        )}
        <div
          onScroll={handleScroll}
          className="flex min-h-0 flex-1 flex-col gap-[12px] overflow-y-auto"
        >
          {comments.map((comment) => (
            <CommentThread
              key={`${comment.integration.id}-${comment.post.id}-${comment.id}`}
              comment={comment}
              post={comment.post}
              channel={comment.integration}
              onOpenPost={(post) =>
                router.push(
                  `/comments?integration=${encodeURIComponent(
                    comment.integration.id
                  )}&post=${encodeURIComponent(post.id)}`
                )
              }
              onReply={(parentCommentId, message) =>
                act(comment, 'replies', { parentCommentId, message })
              }
              onHide={(commentId, hidden) =>
                act(comment, 'hide', { commentId, hidden })
              }
            />
          ))}
          {loadingMore && (
            <div className="flex justify-center py-[12px]">
              <LoadingComponent />
            </div>
          )}
          {!!nextCursor && !loadingMore && (
            <button
              type="button"
              onClick={loadMore}
              className="rounded-[8px] border border-tableBorder bg-newBgColorInner px-[12px] py-[10px] text-[13px] font-[500] text-textColor hover:bg-boxHover"
            >
              {t('load_more', 'Load more')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
