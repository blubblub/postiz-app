import {
  AnalyticsData,
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialComment,
  SocialCommentPost,
  SocialCommentPostsPage,
  SocialCommentsPage,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import dayjs from 'dayjs';
import {
  SocialAbstract,
  ValidityMedia,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import {
  FacebookDto,
  FACEBOOK_PRESET_MAX_CHARS,
} from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/facebook.dto';
import { DribbbleDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/dribbble.dto';
import { Integration } from '@prisma/client';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';
import { timer } from '@gitroom/helpers/utils/timer';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import {
  adsByCreativeId,
  fetchMetaAds,
  mapLimit,
  MetaAdsResult,
} from '@gitroom/nestjs-libraries/integrations/social/meta.ads';
import { MetaAdsCache } from '@gitroom/nestjs-libraries/integrations/social/meta.ads.cache';
import { chunk } from 'lodash';

@Rules(
  "Facebook posts can be text only, or include photos or a video. If it's a story, it must have at least one attachment (photo or video), and each media is published as a separate story."
)
export class FacebookProvider extends SocialAbstract implements SocialProvider {
  identifier = 'facebook';
  name = 'Facebook Page';
  isBetweenSteps = true;
  scopes = [
    'pages_show_list',
    'business_management',
    'pages_manage_posts',
    'pages_manage_engagement',
    'pages_read_engagement',
    // Comments are user-generated content, and the {post-id}/comments edge is
    // refused with "(#200) Missing Permissions" without this — verified against
    // a live Page token that had pages_read_engagement but not this: even
    // fields=id was rejected. pages_read_engagement only covers the Page's own
    // content, so the comment screen needs this to list anything at all.
    'pages_read_user_content',
    'read_insights',
  ];
  // Only needed to discover the posts behind ads (dark posts). Deliberately NOT
  // in `scopes`: checkScopes() rejects the entire connection when one scope is
  // missing, and Meta grants ads_* only to users with a role on the app until
  // App Review — requiring it would break connecting Facebook at all rather
  // than just hiding ad posts.
  //
  // `pages_manage_ads` is deliberately absent. It is required by
  // /{page-id}/ads_posts, but it is not offered by every app type — a legacy
  // app-type app cannot be granted it at all — so ad posts are discovered
  // through the Marketing API instead, which needs only ads_management. Asking
  // for a permission the app can never hold just adds noise to the consent
  // screen.
  optionalScopes = ['ads_management'];
  override maxConcurrentJob = 500; // Facebook has reasonable rate limits
  editor = 'normal' as const;
  maxLength() {
    return 63206;
  }
  dto = FacebookDto;

  override async checkValidity(
    [firstPost]: Array<ValidityMedia[]>,
    settings: any
  ): Promise<string | true> {
    if (settings?.post_type === 'story') {
      if (!firstPost?.length) {
        return 'Story should have at least one media';
      }
    }
    return true;
  }

  override handleErrors(
    body: string,
    status: number
  ):
    | {
        type: 'refresh-token' | 'bad-body';
        value: string;
      }
    | undefined {
    // Access token validation errors - require re-authentication
    if (body.indexOf('Error validating access token') > -1) {
      return {
        type: 'refresh-token' as const,
        value: 'Please re-authenticate your Facebook account',
      };
    }

    if (body.indexOf('REVOKED_ACCESS_TOKEN') > -1) {
      return {
        type: 'refresh-token' as const,
        value: 'Access token has been revoked, please re-authenticate',
      };
    }

    if (body.indexOf('1366046') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Photos should be smaller than 4 MB and saved as JPG, PNG',
      };
    }

    if (body.indexOf('1390008') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'You are posting too fast, please slow down',
      };
    }

    // Content policy violations
    if (body.indexOf('1346003') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Content flagged as abusive by Facebook',
      };
    }

    if (body.indexOf('1404006') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          "We couldn't post your comment, A security check in facebook required to proceed.",
      };
    }

    if (body.indexOf('2069019') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Invalid file',
      };
    }

    if (body.indexOf('1404102') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Content violates Facebook Community Standards',
      };
    }

    // Permission errors
    if (body.indexOf('1404078') > -1) {
      return {
        type: 'refresh-token' as const,
        value: 'Page publishing authorization required, please re-authenticate',
      };
    }

    if (body.indexOf('1366051') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'These photos were already posted.',
      };
    }

    if (body.indexOf('1609008') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Cannot post Facebook.com links',
      };
    }

    // Parameter validation errors
    if (body.indexOf('2061006') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Invalid URL format in post content',
      };
    }

    if (body.indexOf('1349125') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Invalid content format',
      };
    }

    if (body.indexOf('1404112') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'For security reasons, your account has limited access to the site for a few days',
      };
    }

    if (body.indexOf('Name parameter too long') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Post content is too long',
      };
    }

    // Service errors - checking specific subcodes first
    if (body.indexOf('1363047') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Facebook service temporarily unavailable',
      };
    }

    if (body.indexOf('1609010') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Facebook service temporarily unavailable',
      };
    }

    if (body.indexOf('4854002') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Confirm your identity before you can publish as this Page. Open the Facebook app on your phone and follow the instructions',
      };
    }
    if (body.indexOf('(#100) No permission to publish the video') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Facebook return: No permission to publish the video',
      };
    }
    if (body.indexOf('490') > -1) {
      return {
        type: 'refresh-token' as const,
        value: 'Access token expired, please re-authenticate',
      };
    }

    if (status === 401) {
      return {
        type: 'bad-body' as const,
        value:
          'An unknown error occurred, please try again later or contact support',
      };
    }

    return undefined;
  }

  async refreshToken(refresh_token: string): Promise<AuthTokenDetails> {
    // Same renewal as InstagramProvider.refreshToken; handle a bare user token
    // or a `page___user` composite (user token is the part after `___`).
    const userToken = refresh_token.includes('___')
      ? refresh_token.split('___')[1]
      : refresh_token;

    const { access_token } = await (
      await fetch(
        'https://graph.facebook.com/v20.0/oauth/access_token' +
          '?grant_type=fb_exchange_token' +
          `&client_id=${process.env.FACEBOOK_APP_ID}` +
          `&client_secret=${process.env.FACEBOOK_APP_SECRET}` +
          `&fb_exchange_token=${userToken}`
      )
    ).json();

    if (!access_token) {
      throw new Error('Could not refresh the Facebook token');
    }

    return {
      id: '',
      name: '',
      accessToken: access_token,
      refreshToken: access_token,
      expiresIn: dayjs().add(59, 'days').unix() - dayjs().unix(),
      picture: '',
      username: '',
    };
  }

  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url:
        'https://www.facebook.com/v20.0/dialog/oauth' +
        `?client_id=${process.env.FACEBOOK_APP_ID}` +
        `&redirect_uri=${encodeURIComponent(
          `${process.env.FRONTEND_URL}/integrations/social/facebook`
        )}` +
        `&state=${state}` +
        `&scope=${[...this.scopes, ...this.optionalScopes].join(',')}`,
      codeVerifier: makeId(10),
      state,
    };
  }

  async reConnect(
    id: string,
    requiredId: string,
    accessToken: string
  ): Promise<Omit<AuthTokenDetails, 'refreshToken' | 'expiresIn'>> {
    const information = await this.fetchPageInformation(accessToken, {
      page: requiredId,
    });

    return {
      id: information.id,
      name: information.name,
      accessToken: information.access_token,
      picture: information.picture,
      username: information.username,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const getAccessToken = await (
      await fetch(
        'https://graph.facebook.com/v20.0/oauth/access_token' +
          `?client_id=${process.env.FACEBOOK_APP_ID}` +
          `&redirect_uri=${encodeURIComponent(
            `${process.env.FRONTEND_URL}/integrations/social/facebook${
              params.refresh ? `?refresh=${params.refresh}` : ''
            }`
          )}` +
          `&client_secret=${process.env.FACEBOOK_APP_SECRET}` +
          `&code=${params.code}`
      )
    ).json();

    const { access_token } = await (
      await fetch(
        'https://graph.facebook.com/v20.0/oauth/access_token' +
          '?grant_type=fb_exchange_token' +
          `&client_id=${process.env.FACEBOOK_APP_ID}` +
          `&client_secret=${process.env.FACEBOOK_APP_SECRET}` +
          `&fb_exchange_token=${getAccessToken.access_token}&fields=access_token,expires_in`
      )
    ).json();

    const { data } = await (
      await fetch(
        `https://graph.facebook.com/v20.0/me/permissions?access_token=${access_token}`
      )
    ).json();

    const permissions = data
      .filter((d: any) => d.status === 'granted')
      .map((p: any) => p.permission);
    this.checkScopes(this.scopes, permissions);

    const { id, name, picture } = await (
      await fetch(
        `https://graph.facebook.com/v20.0/me?fields=id,name,picture&access_token=${access_token}`
      )
    ).json();

    return {
      id,
      name,
      accessToken: access_token,
      refreshToken: access_token,
      expiresIn: dayjs().add(59, 'days').unix() - dayjs().unix(),
      picture: picture?.data?.url || '',
      username: '',
    };
  }

  async pages(accessToken: string) {
    const seenIds = new Set<string>();
    const allPages: any[] = [];

    const fetchPaginated = async (startUrl: string) => {
      let nextUrl: string | undefined = startUrl;
      while (nextUrl) {
        const response = await (await fetch(nextUrl)).json();
        if (response.data) {
          for (const page of response.data) {
            if (!seenIds.has(page.id)) {
              seenIds.add(page.id);
              allPages.push(page);
            }
          }
        }
        nextUrl = response.paging?.next;
      }
    };

    // Fetch pages the user explicitly shared during the OAuth dialog
    await fetchPaginated(
      `https://graph.facebook.com/v20.0/me/accounts?fields=id,username,name,access_token,picture.type(large)&limit=100&access_token=${accessToken}`
    );

    // Also fetch pages via Business Manager API to discover pages
    // not selected during the OAuth page selection step
    try {
      let bizUrl:
        | string
        | undefined = `https://graph.facebook.com/v20.0/me/businesses?access_token=${accessToken}`;

      while (bizUrl) {
        const bizResponse = await (await fetch(bizUrl)).json();
        if (bizResponse.data) {
          for (const business of bizResponse.data) {
            try {
              await fetchPaginated(
                `https://graph.facebook.com/v20.0/${business.id}/owned_pages?fields=id,username,name,access_token,picture.type(large)&limit=100&access_token=${accessToken}`
              );
            } catch {
              // Continue with other businesses
            }

            try {
              await fetchPaginated(
                `https://graph.facebook.com/v20.0/${business.id}/client_pages?fields=id,username,name,access_token,picture.type(large)&limit=100&access_token=${accessToken}`
              );
            } catch {
              // Continue with other businesses
            }
          }
        }
        bizUrl = bizResponse.paging?.next;
      }
    } catch {
      // Business Manager API not available for all users
    }

    return allPages;
  }

  async fetchPageInformation(accessToken: string, data: { page: string }) {
    const pageId = data.page;
    const fields = 'id,username,name,access_token,picture.type(large)';

    const searchPaginated = async (startUrl: string) => {
      let url: string | undefined = startUrl;
      while (url) {
        const response = await (await fetch(url)).json();
        if (response.data) {
          const page = response.data.find(
            (p: any) => String(p.id) === String(pageId)
          );
          if (page) {
            return {
              id: page.id,
              name: page.name,
              access_token: page.access_token,
              picture: page.picture?.data?.url || '',
              username: page.username,
            };
          }
        }
        url = response.paging?.next;
      }
      return null;
    };

    // 1. Check /me/accounts
    const fromAccounts = await searchPaginated(
      `https://graph.facebook.com/v20.0/me/accounts?fields=${fields}&limit=100&access_token=${accessToken}`
    );
    if (fromAccounts) return fromAccounts;

    // 2. Check Business Manager owned_pages and client_pages
    try {
      let bizUrl:
        | string
        | undefined = `https://graph.facebook.com/v20.0/me/businesses?access_token=${accessToken}`;

      while (bizUrl) {
        const bizResponse = await (await fetch(bizUrl)).json();
        if (bizResponse.data) {
          for (const business of bizResponse.data) {
            try {
              const fromOwned = await searchPaginated(
                `https://graph.facebook.com/v20.0/${business.id}/owned_pages?fields=${fields}&limit=100&access_token=${accessToken}`
              );
              if (fromOwned) return fromOwned;
            } catch {
              // Continue with other businesses
            }

            try {
              const fromClient = await searchPaginated(
                `https://graph.facebook.com/v20.0/${business.id}/client_pages?fields=${fields}&limit=100&access_token=${accessToken}`
              );
              if (fromClient) return fromClient;
            } catch {
              // Continue with other businesses
            }
          }
        }
        bizUrl = bizResponse.paging?.next;
      }
    } catch {
      // Business Manager API not available for all users
    }

    throw new Error('Page not found in your accounts');
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<FacebookDto>[]
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const isStory = firstPost?.settings?.post_type === 'story';

    let finalId = '';
    let finalUrl = '';
    if (isStory) {
      let lastPostId = '';
      for (const media of firstPost?.media || []) {
        const isVideoStory = hasExtension(media.path, 'mp4');
        if (isVideoStory) {
          const { video_id, upload_url } = await (
            await this.fetch(
              `https://graph.facebook.com/v20.0/${id}/video_stories?upload_phase=start&access_token=${accessToken}`,
              {
                method: 'POST',
              },
              'start video story upload'
            )
          ).json();

          await this.fetch(
            upload_url,
            {
              method: 'POST',
              headers: {
                Authorization: `OAuth ${accessToken}`,
                file_url: media.path,
              },
            },
            'upload video story'
          );

          let videoStatus = 'in_progress';
          let attempts = 0;
          const maxAttempts = 54; // ~9 minutes at 10s interval
          while (videoStatus !== 'upload_complete' && videoStatus !== 'ready') {
            if (attempts++ >= maxAttempts) {
              throw new Error('Video processing timed out');
            }

            const { status } = await (
              await this.fetch(
                `https://graph.facebook.com/v20.0/${video_id}?fields=status&access_token=${accessToken}`,
                undefined,
                '',
                0,
                true
              )
            ).json();
            videoStatus = status?.video_status || 'in_progress';
            if (videoStatus === 'error') {
              throw new Error('Video processing failed');
            }
            if (videoStatus !== 'upload_complete' && videoStatus !== 'ready') {
              await timer(10000);
            }
          }

          const { post_id: storyPostId } = await (
            await this.fetch(
              `https://graph.facebook.com/v20.0/${id}/video_stories?upload_phase=finish&video_id=${video_id}&access_token=${accessToken}`,
              {
                method: 'POST',
              },
              'finish video story upload'
            )
          ).json();

          lastPostId = storyPostId;
        } else {
          const { id: photoId } = await (
            await this.fetch(
              `https://graph.facebook.com/v20.0/${id}/photos?access_token=${accessToken}`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  url: media.path,
                  published: false,
                }),
              },
              'upload photo story'
            )
          ).json();

          const { post_id: storyPostId } = await (
            await this.fetch(
              `https://graph.facebook.com/v20.0/${id}/photo_stories?photo_id=${photoId}&access_token=${accessToken}`,
              {
                method: 'POST',
              },
              'publish photo story'
            )
          ).json();

          lastPostId = storyPostId;
        }
      }

      finalId = lastPostId;
      finalUrl = `https://www.facebook.com/stories/${lastPostId}`;
    } else if (hasExtension(firstPost?.media?.[0]?.path, 'mp4')) {
      const {
        id: videoId,
        permalink_url,
        ...all
      } = await (
        await this.fetch(
          `https://graph.facebook.com/v20.0/${id}/videos?access_token=${accessToken}&fields=id,permalink_url`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              file_url: firstPost?.media?.[0]?.path!,
              description: firstPost.message,
              published: true,
            }),
          },
          'upload mp4'
        )
      ).json();

      finalUrl = 'https://www.facebook.com/reel/' + videoId;
      finalId = videoId;
    } else {
      const uploadPhotos = !firstPost?.media?.length
        ? []
        : await Promise.all(
            firstPost.media.map(async (media) => {
              const { id: photoId } = await (
                await this.fetch(
                  `https://graph.facebook.com/v20.0/${id}/photos?access_token=${accessToken}`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      url: media.path,
                      published: false,
                    }),
                  },
                  'upload images slides'
                )
              ).json();

              return { media_fbid: photoId };
            })
          );

      // Background presets are only valid on text-only posts (no media) and
      // Facebook caps them at ~130 chars, so we only attach the preset when it
      // can apply.
      const presetId =
        !uploadPhotos?.length &&
        firstPost?.settings?.text_format_preset_id &&
        (firstPost.message?.length || 0) <= FACEBOOK_PRESET_MAX_CHARS
          ? firstPost.settings.text_format_preset_id
          : undefined;

      const publishFeed = async (withPreset: boolean) =>
        (
          await this.fetch(
            `https://graph.facebook.com/v20.0/${id}/feed?access_token=${accessToken}&fields=id,permalink_url`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                ...(uploadPhotos?.length
                  ? { attached_media: uploadPhotos }
                  : {}),
                ...(firstPost?.settings?.url
                  ? { link: firstPost.settings.url }
                  : {}),
                ...(withPreset && presetId
                  ? { text_format_preset_id: presetId }
                  : {}),
                message: firstPost.message,
                published: true,
              }),
            },
            'finalize upload'
          )
        ).json();

      // Facebook exposes no official preset list and adds/retires backgrounds
      // over time, so a stale text_format_preset_id can make FB reject the whole
      // post. Observed Graph API responses for a bad preset:
      //   - malformed id  -> HTTP 400, code 100, message names
      //                      "text_format_preset_id" explicitly
      //   - retired numeric id -> HTTP 500, code 1, generic "unknown error"
      //     (our fetch() retries 500s and then reports it with the body stripped)
      // So retry once without the preset on an explicit preset error or a
      // generic/unknown failure, but never on a recognized auth/token error
      // (dropping the background can't fix that). A retry that only succeeds once
      // the preset is removed confirms the preset was the cause.
      const isPresetRejection = (err: any): boolean => {
        const detail = `${err?.details?.[0]?.json ?? ''} ${err?.message ?? ''}`;
        if (
          /access token|re-authenticate|revoked|"code":\s*190\b/i.test(detail)
        ) {
          return false;
        }
        return (
          /text_format_preset_id/i.test(detail) ||
          /"code":\s*1\b/.test(detail) ||
          String(err?.message) === 'Unknown Error'
        );
      };

      let feedResult: any;
      try {
        feedResult = await publishFeed(!!presetId);
      } catch (err) {
        if (!presetId || !isPresetRejection(err)) {
          throw err;
        }
        // Surface the (recovered) rejection in the logs, since the fallback
        // below makes the activity succeed and Facebook's error would otherwise
        // be swallowed silently.
        console.warn(
          'Facebook rejected text_format_preset_id — dropping the background and publishing as plain text',
          {
            preset: presetId,
            facebook: (err as any)?.details?.[0]?.json,
            message: (err as any)?.message,
          }
        );
        feedResult = await publishFeed(false);
      }

      const { id: postId, permalink_url, ...all } = feedResult;

      finalUrl = permalink_url;
      finalId = postId;
    }

    return [
      {
        id: firstPost.id,
        postId: finalId,
        releaseURL: finalUrl,
        status: 'success',
      },
    ];
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails<FacebookDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [commentPost] = postDetails;
    const replyToId = lastCommentId || postId;

    const data = await (
      await this.fetch(
        `https://graph.facebook.com/v20.0/${replyToId}/comments?access_token=${accessToken}&fields=id,permalink_url`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...(commentPost.media?.length
              ? { attachment_url: commentPost.media[0].path }
              : {}),
            message: commentPost.message,
          }),
        },
        'add comment'
      )
    ).json();

    return [
      {
        id: commentPost.id,
        postId: data.id,
        releaseURL: data.permalink_url,
        status: 'success',
      },
    ];
  }

  async fetchComments(
    id: string,
    accessToken: string,
    postId: string,
    integration: Integration,
    cursor?: string
  ): Promise<SocialCommentsPage> {
    const fields = [
      'id',
      'message',
      'from{name,id}',
      'created_time',
      'like_count',
      'is_hidden',
      'comment_count',
      'permalink_url',
      'comments.limit(25){id,message,from{name,id},created_time,like_count,is_hidden,comment_count,permalink_url}',
    ].join(',');
    const params = new URLSearchParams({
      access_token: accessToken,
      fields,
      limit: '100',
    });

    if (cursor) {
      params.set('after', cursor);
    }

    const response = await (
      await this.fetch(
        `https://graph.facebook.com/v20.0/${postId}/comments?${params.toString()}`,
        {},
        'fetch comments'
      )
    ).json();

    const normalize = (comment: any): SocialComment => ({
      id: String(comment.id),
      text: comment.message || '',
      username: comment.from?.name,
      timestamp: comment.created_time,
      likeCount: Number(comment.like_count || 0),
      hidden: comment.is_hidden ?? comment.hidden,
      replies: (comment.comments?.data || []).map(normalize),
    });

    return {
      comments: (response.data || []).map(normalize),
      next: response.paging?.next ? response.paging?.cursors?.after : undefined,
    };
  }

  async replyToComment(
    _id: string,
    _postId: string,
    commentId: string,
    accessToken: string,
    message: string,
    _integration: Integration
  ): Promise<{ id: string }> {
    const data = await (
      await this.fetch(
        `https://graph.facebook.com/v20.0/${commentId}/comments?access_token=${accessToken}&fields=id`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message }),
        },
        'reply to comment'
      )
    ).json();

    return { id: String(data.id) };
  }

  async hideComment(
    _id: string,
    _postId: string,
    commentId: string,
    accessToken: string,
    hidden: boolean,
    _integration: Integration
  ): Promise<{ id: string; hidden: boolean }> {
    await (
      await this.fetch(
        `https://graph.facebook.com/v20.0/${commentId}?access_token=${accessToken}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ is_hidden: hidden }),
        },
        'hide comment'
      )
    ).json();

    return { id: String(commentId), hidden };
  }

  private static readonly POST_FIELDS =
    'id,message,story,created_time,permalink_url,full_picture,comments.limit(0).summary(true),likes.limit(0).summary(true)';

  // Two clocks: the Marketing API walk answers "which ads exist" and is slow
  // and quota-hungry, while the batched post read answers "how many comments"
  // and is what a moderator watches. See InstagramProvider for the full note.
  // Static, so they survive however the provider is instantiated per request.
  private static readonly adPostsCache = new MetaAdsCache<{
    posts: SocialCommentPost[];
    complete: boolean;
  }>(15 * 60 * 1000, 8000, 60 * 1000, 100, (listing) => listing.complete);
  private static readonly adWalkCache = new MetaAdsCache<MetaAdsResult>(
    60 * 60 * 1000,
    8000,
    60 * 1000,
    100,
    (walk) => walk.unreadable.length === 0
  );

  private static toCommentPost(post: any, isAd = false): SocialCommentPost {
    return {
      id: String(post.id),
      releaseId: String(post.id),
      releaseURL: post.permalink_url,
      content: post.message || post.story || 'Facebook post',
      publishDate: post.created_time,
      thumbnail: post.full_picture,
      commentCount: Number(post.comments?.summary?.total_count || 0),
      likeCount: Number(post.likes?.summary?.total_count || 0),
      ...(isAd ? { isAd: true } : {}),
    };
  }

  /**
   * The page posts behind this account's ads, including dark posts that were
   * created inside an ad and never appear on /posts.
   *
   * Reached through the Marketing API rather than /{page-id}/ads_posts: that
   * edge additionally requires pages_manage_ads, which some app types are never
   * offered. The user token lives in Integration.refreshToken — the page token
   * this provider is otherwise given cannot resolve `me` to a user.
   */
  private async fetchAdPosts(
    pageId: string,
    accessToken: string,
    userToken: string
  ): Promise<{ posts: SocialCommentPost[]; complete: boolean }> {
    // Cached on the slower clock — see adWalkCache. Blocking, because this is
    // already inside adPostsCache's background refresh: returning early with no
    // ads would cache an empty list as if it were an answer.
    const walk = await FacebookProvider.adWalkCache.readBlocking(
      `facebook:${pageId}`,
      () =>
        fetchMetaAds(userToken, ['effective_object_story_id'], (url) =>
          this.fetch(url, {}, 'fetch ads')
        )
    );

    if (!walk.value) {
      throw new Error('facebook ad walk failed');
    }

    const { ads, accounts, unreadable } = walk.value;

    if (unreadable.length) {
      console.warn(
        `[facebook] ad walk incomplete: ${unreadable.length} of ${accounts.length} discovered ad accounts or account edges could not be read`,
        unreadable.slice(0, 5)
      );
    }

    // Only this Page's ads: one ad account commonly promotes several Pages, and
    // a story id is `<page-id>_<post-id>`.
    const byPost = adsByCreativeId(ads, 'effective_object_story_id', (ad) =>
      String(ad?.creative?.effective_object_story_id || '').startsWith(
        `${pageId}_`
      )
    );

    if (!byPost.size) {
      return { posts: [], complete: unreadable.length === 0 };
    }

    const ids = [...byPost.keys()];

    // Batched node read, with the PAGE token — reading a page post needs the
    // page permissions, not the ads one. Graph caps `ids` at 50 and is atomic,
    // so chunk it; a failed chunk costs those cards, not the whole listing.
    // Bounded, not `Promise.all`: a year of ads runs to thousands of posts, and
    // firing every batch at once is how you earn a rate limit.
    const posts: Record<string, any> = Object.assign(
      {},
      ...(await mapLimit(chunk(ids, 50), 8, (batch) =>
        this.fetch(
          `https://graph.facebook.com/v20.0/?ids=${batch.join(',')}&fields=${
            FacebookProvider.POST_FIELDS
          }&access_token=${accessToken}`,
          {},
          'fetch ad posts'
        )
          .then((response) => response.json())
          .catch(() => ({}))
      ))
    );

    return {
      posts: ids.flatMap((postId) => {
      const found = posts?.[postId];
      if (found?.id) {
        // This is a comment screen, and an ad with no comments is not something
        // anyone can act on — on the live account they outnumber the actionable
        // ones better than ten to one. The count refreshes on the fast clock, so
        // a newly commented ad appears here within minutes.
        if (!Number(found.comments?.summary?.total_count || 0)) {
          return [];
        }

        return FacebookProvider.toCommentPost(found, true);
      }

      // Dark posts can refuse a direct node read while their comments edge
      // still works, so the count is unknown rather than zero — keep the card.
      const ad = byPost.get(postId);
      return {
        id: postId,
        releaseId: postId,
        content: ad?.name || 'Facebook ad',
        publishDate: ad?.created_time || new Date().toISOString(),
        isAd: true,
      };
      }),
      complete: unreadable.length === 0,
    };
  }

  async fetchCommentPosts(
    id: string,
    accessToken: string,
    integration: Integration,
    limit = 25,
    cursor?: string
  ): Promise<SocialCommentPostsPage> {
    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const params = new URLSearchParams({
      access_token: accessToken,
      fields: FacebookProvider.POST_FIELDS,
      limit: String(safeLimit),
    });
    if (cursor) {
      params.set('after', cursor);
    }

    // The ads walk is a separate API with its own paging, so it rides along on
    // the first page only rather than being threaded through the /posts cursor.
    // The user token it needs is kept in refreshToken; Facebook's refreshToken()
    // is a no-op stub, so nothing overwrites it.
    const userToken = integration?.refreshToken || '';
    const wantsAds = !cursor && !!userToken;

    const [response, ads] = await Promise.all([
      this.fetch(
        `https://graph.facebook.com/v20.0/${id}/posts?${params.toString()}`,
        {},
        'fetch comment posts'
      ).then((postsResponse) => postsResponse.json()),
      wantsAds
        ? // Cached and bounded: an exhaustive walk across a business's ad
          // accounts is far slower than a screen load can absorb. A failed walk
          // (no ads_management, or an ad account we cannot read) degrades to the
          // organic list — including RefreshToken, because handleErrors treats
          // any body containing '490' as an expired token and fbtrace_ids
          // contain '490' by chance, so letting this optional branch report
          // token death would randomly flag a healthy channel as needing
          // reconnection. The /posts call beside it is the authority on that.
          FacebookProvider.adPostsCache.read(`facebook:${id}`, () =>
            this.fetchAdPosts(id, accessToken, userToken)
          )
        : { value: { posts: [] as SocialCommentPost[], complete: true }, complete: true },
    ]);

    const adPosts = ads.value?.posts || [];

    const organic = (response.data || []).map((post: any) =>
      FacebookProvider.toCommentPost(post)
    );

    // A boosted organic post shows up in both; keep the ad copy so it is badged.
    const byId = new Map<string, SocialCommentPost>();
    for (const post of [...organic, ...adPosts]) {
      if (!byId.has(post.id) || post.isAd) {
        byId.set(post.id, post);
      }
    }

    const posts = [...byId.values()].sort((a, b) =>
      (b.publishDate || '').localeCompare(a.publishDate || '')
    );

    // `cursors.after` is returned on the last page too, so it must stay gated on
    // paging.next — otherwise "load more" never stops.
    const next = response.paging?.next
      ? response.paging?.cursors?.after
      : undefined;

    return {
      posts,
      total: posts.length,
      page: 0,
      limit: safeLimit,
      hasMore: !!next,
      next,
      // The first walk for a large business outlives the request that started
      // it. Say so, rather than letting an ad-less list imply there are no ads.
      ...(ads.complete && ads.value?.complete !== false ? {} : { syncing: true }),
    };
  }

  async analytics(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const until = dayjs().endOf('day').unix();
    const since = dayjs().subtract(date, 'day').unix();

    // Reach/impression metrics (page_impressions_unique, page_posts_impressions_unique,
    // page_video_views) were deprecated by Meta on 2026-06-15 and now return an
    // "invalid metric" error. They are replaced by the Media Views metrics, which
    // require Graph API v23.0+:
    //   - page_total_media_view_unique: total unique views on the page's media (reach)
    //   - page_media_view: total media views, broken down between paid and organic
    const { data } = await (
      await fetch(
        `https://graph.facebook.com/v23.0/${id}/insights?metric=page_total_media_view_unique,page_media_view,page_post_engagements,page_daily_follows&access_token=${accessToken}&period=day&since=${since}&until=${until}`
      )
    ).json();

    // page_media_view returns paid/organic breakdowns as an object; sum them to
    // keep the single-total UI working.
    const sumValue = (value: any): number => {
      if (value && typeof value === 'object') {
        return Object.values(value as Record<string, number>).reduce(
          (sum: number, v: number) => sum + (Number(v) || 0),
          0
        );
      }
      return Number(value) || 0;
    };

    return (
      data?.map((d: any) => ({
        label:
          d.name === 'page_total_media_view_unique'
            ? 'Page Impressions'
            : d.name === 'page_post_engagements'
            ? 'Posts Engagement'
            : d.name === 'page_daily_follows'
            ? 'Page followers'
            : 'Media views',
        percentageChange: 5,
        data: d?.values?.map((v: any) => ({
          total: sumValue(v.value),
          date: dayjs(v.end_time).format('YYYY-MM-DD'),
        })),
      })) || []
    );
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const today = dayjs().format('YYYY-MM-DD');

    try {
      // Fetch post insights from Facebook Graph API.
      // post_impressions_unique was deprecated by Meta on 2026-06-15; it is replaced
      // by post_total_media_view_unique (unique media views = reach), available on
      // Graph API v23.0+. Engagement metrics below are unaffected.
      const { data } = await (
        await this.fetch(
          `https://graph.facebook.com/v23.0/${postId}/insights?metric=post_total_media_view_unique,post_reactions_by_type_total,post_clicks,post_clicks_by_type&access_token=${accessToken}`
        )
      ).json();

      if (!data || data.length === 0) {
        return [];
      }

      const result: AnalyticsData[] = [];

      for (const metric of data) {
        const value = metric.values?.[0]?.value;
        if (value === undefined) continue;

        let label = '';
        let total = '';

        switch (metric.name) {
          case 'post_total_media_view_unique':
            label = 'Impressions';
            total = String(value);
            break;
          case 'post_clicks':
            label = 'Clicks';
            total = String(value);
            break;
          case 'post_clicks_by_type':
            // This returns an object with click types
            if (typeof value === 'object') {
              const totalClicks = Object.values(
                value as Record<string, number>
              ).reduce((sum: number, v: number) => sum + v, 0);
              label = 'Clicks by Type';
              total = String(totalClicks);
            }
            break;
          case 'post_reactions_by_type_total':
            // This returns an object with reaction types
            if (typeof value === 'object') {
              const totalReactions = Object.values(
                value as Record<string, number>
              ).reduce((sum: number, v: number) => sum + v, 0);
              label = 'Reactions';
              total = String(totalReactions);
            }
            break;
        }

        if (label) {
          result.push({
            label,
            percentageChange: 0,
            data: [{ total, date: today }],
          });
        }
      }

      return result;
    } catch (err) {
      console.error('Error fetching Facebook post analytics:', err);
      return [];
    }
  }
}
