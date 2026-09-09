import {
  forwardRef,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import {
  AnalyticsData,
  SocialComment,
  AdAccountDiagnostics,
  OrgComment,
  OrgCommentsPage,
  SocialAllComment,
  SocialAllCommentsPage,
  SocialCommentPost,
  SocialCommentPostsPage,
  SocialCommentsPage,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { Integration, Organization } from '@prisma/client';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import dayjs from 'dayjs';
import { timer } from '@gitroom/helpers/utils/timer';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { RefreshToken } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { IntegrationTimeDto } from '@gitroom/nestjs-libraries/dtos/integrations/integration.time.dto';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { PlugDto } from '@gitroom/nestjs-libraries/dtos/plugs/plug.dto';
import { difference, orderBy, uniq } from 'lodash';
import { mapLimit } from '@gitroom/nestjs-libraries/integrations/social/meta.ads';
import utc from 'dayjs/plugin/utc';
import { AutopostRepository } from '@gitroom/nestjs-libraries/database/prisma/autopost/autopost.repository';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { TemporalService } from 'nestjs-temporal-core';

dayjs.extend(utc);

@Injectable()
export class IntegrationService {
  private storage = UploadFactory.createStorage();
  constructor(
    private _integrationRepository: IntegrationRepository,
    private _autopostsRepository: AutopostRepository,
    private _integrationManager: IntegrationManager,
    private _notificationService: NotificationService,
    @Inject(forwardRef(() => RefreshIntegrationService))
    private _refreshIntegrationService: RefreshIntegrationService,
    private _temporalService: TemporalService
  ) {}

  async changeActiveCron(orgId: string) {
    const data = await this._autopostsRepository.getAutoposts(orgId);

    for (const item of data.filter((f) => f.active)) {
      try {
        await this._temporalService.terminateWorkflow(`autopost-${item.id}`);
      } catch (err) {}
    }

    return true;
  }

  getMentions(platform: string, q: string) {
    return this._integrationRepository.getMentions(platform, q);
  }

  insertMentions(
    platform: string,
    mentions: { name: string; username: string; image: string }[]
  ) {
    return this._integrationRepository.insertMentions(platform, mentions);
  }

  async setTimes(
    orgId: string,
    integrationId: string,
    times: IntegrationTimeDto
  ) {
    return this._integrationRepository.setTimes(orgId, integrationId, times);
  }

  updateProviderSettings(org: string, id: string, additionalSettings: string) {
    return this._integrationRepository.updateProviderSettings(
      org,
      id,
      additionalSettings
    );
  }

  checkPreviousConnections(org: string, id: string) {
    return this._integrationRepository.checkPreviousConnections(org, id);
  }

  async createOrUpdateIntegration(
    additionalSettings:
      | {
          title: string;
          description: string;
          type: 'checkbox' | 'text' | 'textarea';
          value: any;
          regex?: string;
        }[]
      | undefined,
    oneTimeToken: boolean,
    org: string,
    name: string,
    picture: string | undefined,
    type: 'article' | 'social',
    internalId: string,
    provider: string,
    token: string,
    refreshToken = '',
    expiresIn?: number,
    username?: string,
    isBetweenSteps = false,
    refresh?: string,
    timezone?: number,
    customInstanceDetails?: string
  ) {
    const uploadedPicture = picture
      ? picture?.indexOf('imagedelivery.net') > -1
        ? picture
        : await this.storage.uploadSimple(picture)
      : undefined;

    return this._integrationRepository.createOrUpdateIntegration(
      additionalSettings,
      oneTimeToken,
      org,
      name,
      uploadedPicture,
      type,
      internalId,
      provider,
      token,
      refreshToken,
      expiresIn,
      username,
      isBetweenSteps,
      refresh,
      timezone,
      customInstanceDetails
    );
  }

  updateIntegrationGroup(org: string, id: string, group: string) {
    return this._integrationRepository.updateIntegrationGroup(org, id, group);
  }

  updateOnCustomerName(org: string, id: string, name: string) {
    return this._integrationRepository.updateOnCustomerName(org, id, name);
  }

  getIntegrationsList(org: string) {
    return this._integrationRepository.getIntegrationsList(org);
  }

  getIntegrationForOrder(id: string, order: string, user: string, org: string) {
    return this._integrationRepository.getIntegrationForOrder(
      id,
      order,
      user,
      org
    );
  }

  updateNameAndUrl(id: string, name: string, url: string) {
    return this._integrationRepository.updateNameAndUrl(id, name, url);
  }

  getIntegrationById(org: string, id: string) {
    return this._integrationRepository.getIntegrationById(org, id);
  }

  private assertCommentIntegrationEnabled(integration: Integration) {
    if (integration.disabled || integration.refreshNeeded) {
      throw new HttpException(
        'Integration is disabled or needs to be reconnected',
        HttpStatus.BAD_REQUEST
      );
    }
  }

  async refreshToken(provider: SocialProvider, refresh: string) {
    try {
      const { refreshToken, accessToken, expiresIn } =
        await provider.refreshToken(refresh);

      if (!refreshToken || !accessToken || !expiresIn) {
        return false;
      }

      return { refreshToken, accessToken, expiresIn };
    } catch (e) {
      return false;
    }
  }

  async disconnectChannel(orgId: string, integration: Integration) {
    await this._integrationRepository.disconnectChannel(orgId, integration.id);
    await this.informAboutRefreshError(orgId, integration);
  }

  async informAboutRefreshError(
    orgId: string,
    integration: Integration,
    err = ''
  ) {
    await this._notificationService.inAppNotification(
      orgId,
      `Could not refresh your ${integration.providerIdentifier} channel ${err}`,
      `Could not refresh your ${integration.providerIdentifier} channel ${err}. Please go back to the system and connect it again ${process.env.FRONTEND_URL}/launches`,
      true,
      false,
      'info'
    );
  }

  async refreshNeeded(org: string, id: string) {
    return this._integrationRepository.refreshNeeded(org, id);
  }

  async setBetweenRefreshSteps(id: string) {
    return this._integrationRepository.setBetweenRefreshSteps(id);
  }

  async refreshTokens() {
    const expiring = await this._integrationRepository.needsToBeRefreshed();
    // Meta rows can carry a bogus far-future expiry, so also sweep them by age.
    const meta = await this._integrationRepository.needsProactiveRefresh(
      ['instagram', 'facebook'],
      30
    );

    const seen = new Set<string>();
    const integrations = [...expiring, ...meta].filter((i) => {
      if (seen.has(i.id)) {
        return false;
      }
      seen.add(i.id);
      return true;
    });

    for (const integration of integrations) {
      // Go through the full refresh so reConnect() rebuilds the page token and
      // the stored `page___user` composite, not just the user token.
      await this._refreshIntegrationService.refresh(integration, 'cron');
    }
  }

  async disableChannel(org: string, id: string) {
    return this._integrationRepository.disableChannel(org, id);
  }

  async enableChannel(org: string, totalChannels: number, id: string) {
    const integrations = (
      await this._integrationRepository.getIntegrationsList(org)
    ).filter((f) => !f.disabled);
    if (
      !!process.env.STRIPE_PUBLISHABLE_KEY &&
      integrations.length >= totalChannels
    ) {
      throw new Error('You have reached the maximum number of channels');
    }

    return this._integrationRepository.enableChannel(org, id);
  }

  async getPostsForChannel(org: string, id: string) {
    return this._integrationRepository.getPostsForChannel(org, id);
  }

  async deleteChannel(org: string, id: string) {
    return this._integrationRepository.deleteChannel(org, id);
  }

  async disableIntegrations(org: string, totalChannels: number) {
    return this._integrationRepository.disableIntegrations(org, totalChannels);
  }

  async checkForDeletedOnceAndUpdate(org: string, page: string) {
    return this._integrationRepository.checkForDeletedOnceAndUpdate(org, page);
  }

  async saveProviderPage(org: string, id: string, data: any) {
    const getIntegration = await this._integrationRepository.getIntegrationById(
      org,
      id
    );
    if (!getIntegration) {
      throw new HttpException('Integration not found', HttpStatus.NOT_FOUND);
    }
    if (!getIntegration.inBetweenSteps) {
      throw new HttpException('Invalid request', HttpStatus.BAD_REQUEST);
    }

    const provider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (!provider.fetchPageInformation) {
      throw new HttpException(
        'Provider does not support page selection',
        HttpStatus.BAD_REQUEST
      );
    }

    const getIntegrationInformation = await provider.fetchPageInformation(
      getIntegration.token,
      data
    );

    await this.checkForDeletedOnceAndUpdate(
      org,
      String(getIntegrationInformation.id)
    );
    await this._integrationRepository.updateIntegration(id, {
      picture: getIntegrationInformation.picture,
      internalId: String(getIntegrationInformation.id),
      organizationId: org,
      name: getIntegrationInformation.name,
      inBetweenSteps: false,
      token: getIntegrationInformation.access_token,
      // authenticate() stored the user token in `token`. The page token
      // replaces that; keep the user token in refreshToken so Facebook can
      // still walk ads (`/me/adaccounts` does not work with a page token).
      refreshToken: getIntegration.refreshToken || getIntegration.token,
      profile: getIntegrationInformation.username,
    });

    return { success: true };
  }

  async checkAnalytics(
    org: Organization,
    integration: string,
    date: string,
    forceRefresh = false
  ): Promise<AnalyticsData[]> {
    const getIntegration = await this.getIntegrationById(org.id, integration);

    if (!getIntegration) {
      throw new Error('Invalid integration');
    }

    if (getIntegration.type !== 'social') {
      return [];
    }

    const integrationProvider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (
      dayjs(getIntegration?.tokenExpiration).isBefore(dayjs()) ||
      forceRefresh
    ) {
      const data = await this._refreshIntegrationService.refresh(
        getIntegration
      );
      if (!data) {
        return [];
      }

      const { accessToken } = data;

      if (accessToken) {
        getIntegration.token = accessToken;

        if (integrationProvider.refreshWait) {
          await timer(10000);
        }
      } else {
        await this.disconnectChannel(org.id, getIntegration);
        return [];
      }
    }

    const getIntegrationData = await ioRedis.get(
      `integration:${org.id}:${integration}:${date}`
    );
    if (getIntegrationData) {
      return JSON.parse(getIntegrationData);
    }

    if (integrationProvider.analytics) {
      try {
        const loadAnalytics = await integrationProvider.analytics(
          getIntegration.internalId,
          getIntegration.token,
          +date
        );
        await ioRedis.set(
          `integration:${org.id}:${integration}:${date}`,
          JSON.stringify(loadAnalytics),
          'EX',
          !process.env.NODE_ENV || process.env.NODE_ENV === 'development'
            ? 1
            : 3600
        );
        return loadAnalytics;
      } catch (e) {
        if (e instanceof RefreshToken) {
          return this.checkAnalytics(org, integration, date, true);
        }
      }
    }

    return [];
  }

  async fetchCommentPosts(
    orgId: string,
    integration: string,
    limit = 25,
    cursor?: string,
    forceRefresh = false
  ): Promise<SocialCommentPostsPage> {
    const getIntegration = await this.getIntegrationById(orgId, integration);

    if (!getIntegration) {
      throw new HttpException('Invalid integration', HttpStatus.NOT_FOUND);
    }

    this.assertCommentIntegrationEnabled(getIntegration);

    if (getIntegration.type !== 'social') {
      throw new HttpException(
        'Comments are only available for social integrations',
        HttpStatus.BAD_REQUEST
      );
    }

    const integrationProvider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (!integrationProvider.fetchCommentPosts) {
      throw new HttpException(
        'Comments are not supported for this integration',
        HttpStatus.BAD_REQUEST
      );
    }

    if (
      dayjs(getIntegration?.tokenExpiration).isBefore(dayjs()) ||
      getIntegration.refreshNeeded ||
      forceRefresh
    ) {
      const data = await this._refreshIntegrationService.refresh(
        getIntegration,
        'fetch comment posts'
      );
      if (!data || !data.accessToken) {
        throw new HttpException(
          'Integration needs to be reconnected',
          HttpStatus.UNAUTHORIZED
        );
      }

      getIntegration.token = data.accessToken;

      if (integrationProvider.refreshWait) {
        await timer(10000);
      }
    }

    // Providers whose listing can only be crawled in slices are served from the
    // cache, with the crawl topping it up in the background.
    if (integrationProvider.commentPostsSliceMs) {
      return this.readCachedCommentPosts(
        getIntegration,
        integrationProvider,
        limit,
        cursor
      );
    }

    try {
      return await integrationProvider.fetchCommentPosts(
        getIntegration.internalId,
        getIntegration.token,
        getIntegration,
        limit,
        cursor
      );
    } catch (e) {
      if (e instanceof RefreshToken && !forceRefresh) {
        return this.fetchCommentPosts(orgId, integration, limit, cursor, true);
      }
      throw e;
    }
  }

  /**
   * Diagnostic behind the comment screen: which ad accounts this channel's
   * token reaches and how many of their ads belong to the channel. An ad whose
   * account is missing here can never show up in the comment post list.
   */
  async fetchAdAccountDiagnostics(
    orgId: string,
    integration: string
  ): Promise<AdAccountDiagnostics> {
    const getIntegration = await this.getIntegrationById(orgId, integration);

    if (!getIntegration) {
      throw new HttpException('Invalid integration', HttpStatus.NOT_FOUND);
    }

    this.assertCommentIntegrationEnabled(getIntegration);

    const integrationProvider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (!integrationProvider.adAccountDiagnostics) {
      throw new HttpException(
        'Ad account diagnostics are not available for this integration',
        HttpStatus.BAD_REQUEST
      );
    }

    if (
      dayjs(getIntegration?.tokenExpiration).isBefore(dayjs()) ||
      getIntegration.refreshNeeded
    ) {
      const data = await this._refreshIntegrationService.refresh(
        getIntegration,
        'ad account diagnostics'
      );
      if (!data || !data.accessToken) {
        throw new HttpException(
          'Integration needs to be reconnected',
          HttpStatus.UNAUTHORIZED
        );
      }
      getIntegration.token = data.accessToken;
    }

    return integrationProvider.adAccountDiagnostics(
      getIntegration.internalId,
      getIntegration.token,
      getIntegration
    );
  }

  async probeCommentPost(
    orgId: string,
    integration: string,
    postId: string
  ): Promise<Record<string, unknown>> {
    const getIntegration = await this.getIntegrationById(orgId, integration);

    if (!getIntegration) {
      throw new HttpException('Invalid integration', HttpStatus.NOT_FOUND);
    }

    this.assertCommentIntegrationEnabled(getIntegration);

    const integrationProvider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (!integrationProvider.probeCommentPost) {
      throw new HttpException(
        'Post probe is not available for this integration',
        HttpStatus.BAD_REQUEST
      );
    }

    return integrationProvider.probeCommentPost(
      getIntegration.internalId,
      getIntegration.token,
      getIntegration,
      postId
    );
  }

  // Integrations currently being crawled, so a burst of requests (or infinite
  // scroll) can't start the same crawl several times over.
  private static readonly crawlingCommentPosts = new Set<string>();

  private async readCachedCommentPosts(
    integration: Integration,
    provider: SocialProvider,
    limit: number,
    cursor?: string
  ): Promise<SocialCommentPostsPage> {
    const offset = Math.max(Number(cursor) || 0, 0);
    const rows = await this._integrationRepository.getCachedCommentPosts(
      integration.id,
      limit,
      offset
    );

    // Keep filling in the background — the first crawl of a long-dormant
    // account takes minutes, so it must not block the response. Once the
    // history is done we still come back periodically, otherwise posts made
    // after the backfill would never appear.
    const staleAfter = dayjs().subtract(15, 'minutes');
    const stale =
      !integration.commentPostsSyncedAt ||
      dayjs(integration.commentPostsSyncedAt).isBefore(staleAfter);

    if (!integration.commentPostsDone || stale) {
      this.crawlCommentPosts(integration, provider);
    }

    const nextOffset = offset + rows.length;
    const total = await this._integrationRepository.countCachedCommentPosts(
      integration.id
    );
    // Only advertise more when more is actually cached. Saying "yes" while the
    // crawl is still running would have infinite scroll re-requesting a page
    // that cannot grow yet; the extra posts show up on the next load instead.
    const hasMore = nextOffset < total;

    return {
      // Lets the screen say "still syncing" instead of showing a bare empty
      // list: the first crawl of a dormant account takes minutes before the
      // first post appears.
      syncing: !integration.commentPostsDone,
      posts: rows.map((row) => ({
        id: row.postId,
        releaseId: row.postId,
        releaseURL: row.releaseURL || undefined,
        content: row.content,
        publishDate: row.publishDate.toISOString(),
        thumbnail: row.thumbnail || undefined,
        commentCount: row.commentCount,
        likeCount: row.likeCount,
      })),
      total,
      page: 0,
      limit,
      hasMore,
      next: hasMore ? String(nextOffset) : undefined,
    };
  }

  /**
   * Walks the provider's timeline backwards in slices and caches what it finds.
   *
   * Runs detached: the first pass over a dormant account is thousands of
   * requests, so callers fire it and read whatever is cached so far. Progress
   * is persisted after every batch, so a restart resumes instead of starting
   * over, and the whole thing is deliberately slow — see PACE_MS.
   */
  private async crawlCommentPosts(
    integration: Integration,
    provider: SocialProvider
  ) {
    const sliceMs = provider.commentPostsSliceMs;
    if (!sliceMs || !provider.fetchCommentPosts) {
      return;
    }

    if (IntegrationService.crawlingCommentPosts.has(integration.id)) {
      return;
    }
    IntegrationService.crawlingCommentPosts.add(integration.id);

    // Stay well under any per-app quota: this is a background backfill, it has
    // no deadline, and the account is shared with whatever else uses the app.
    const PACE_MS = 500;
    const BATCH = 20;
    // Empty stretches are the slow part — a dormant account is hundreds of
    // slices of nothing. Those slices don't depend on each other's results, so
    // scan a few at a time; the moment posts turn up we go back to stepping
    // sequentially, where the adaptive jump is doing the work anyway.
    const SCAN_WIDTH = 4;
    // 5 years back: this account's oldest visible posts are ~4 years old, and a
    // shorter floor would drop history the screen shows today.
    const HISTORY_FLOOR = dayjs().subtract(5, 'years').valueOf();
    const RATE_LIMIT_BACKOFF_MS = 30000;
    const MAX_RATE_LIMIT_RETRIES = 5;

    // Two modes. The backfill walks the whole history once, resuming from the
    // saved cursor. After that we only re-scan the stretch since the last run,
    // which is a handful of slices rather than years of timeline.
    const catchUp = !!integration.commentPostsDone;
    const FLOOR = catchUp
      ? dayjs(integration.commentPostsSyncedAt || dayjs().subtract(7, 'days'))
          // Overlap a day so nothing falls between two runs.
          .subtract(1, 'day')
          .valueOf()
      : HISTORY_FLOOR;

    let cursor = catchUp
      ? dayjs().valueOf()
      : Number(integration.commentPostsCursor) || dayjs().valueOf();
    let sinceSave = 0;
    let rateLimitHits = 0;
    let scanning = true;

    try {
      while (cursor > FLOOR) {
        let pages: SocialCommentPostsPage[];
        try {
          // One slice while we're in content, SCAN_WIDTH consecutive slices
          // while we're in a gap.
          const width = scanning ? SCAN_WIDTH : 1;
          pages = await Promise.all(
            Array.from({ length: width }, (_, index) =>
              provider.fetchCommentPosts!(
                integration.internalId,
                integration.token,
                integration,
                20,
                String(cursor - index * sliceMs)
              )
            )
          );
          rateLimitHits = 0;
        } catch (err: any) {
          if (err?.name === 'TiktokBusinessRateLimit') {
            rateLimitHits++;
            if (rateLimitHits > MAX_RATE_LIMIT_RETRIES) {
              // Give up for now rather than hammering — the saved cursor means
              // the next visit picks up exactly here.
              break;
            }

            // Exponential backoff, then retry the same slice.
            await timer(RATE_LIMIT_BACKOFF_MS * Math.pow(2, rateLimitHits - 1));
            continue;
          }

          if (err instanceof RefreshToken) {
            // Token died mid-crawl; stop and let the next request refresh it.
            break;
          }

          throw err;
        }

        const posts = pages.flatMap((page) => page.posts || []);
        // Scan wide again only while the timeline stays empty.
        scanning = !posts.length;
        if (posts.length) {
          await this._integrationRepository.saveCachedCommentPosts(
            integration.id,
            posts.map((post) => ({
              postId: post.id,
              content: post.content,
              publishDate: new Date(post.publishDate),
              releaseURL: post.releaseURL,
              thumbnail: post.thumbnail,
              commentCount: post.commentCount,
              likeCount: post.likeCount,
            }))
          );
        }

        // A full page means the window may hold more than we got, so resume
        // from the oldest post rather than stepping past it. A short page means
        // the slice is exhausted and we can step a whole slice back — which is
        // also what makes dense stretches cheap to crawl.
        const oldest = posts.length
          ? Math.min(
              ...posts.map((post) => new Date(post.publishDate).getTime())
            )
          : undefined;

        const scannedTo = cursor - pages.length * sliceMs;
        cursor =
          posts.length >= 20 && oldest
            ? oldest - 1000
            : Math.min(scannedTo, oldest ? oldest - 1000 : Infinity);

        if (++sinceSave >= BATCH) {
          sinceSave = 0;
          await this._integrationRepository.saveCommentPostsCrawlState(
            integration.id,
            // In catch-up mode the backfill cursor is finished history — don't
            // overwrite it with where this short scan happens to be.
            catchUp ? { syncedAt: new Date() } : { cursor: String(cursor) }
          );
        }

        await timer(PACE_MS);
      }

      await this._integrationRepository.saveCommentPostsCrawlState(
        integration.id,
        catchUp
          ? { done: true, syncedAt: new Date() }
          : {
              cursor: String(cursor),
              done: cursor <= FLOOR,
              syncedAt: new Date(),
            }
      );
    } catch (err) {
      // Never let a background crawl take down the request that started it.
      await this._integrationRepository
        .saveCommentPostsCrawlState(
          integration.id,
          catchUp ? { syncedAt: new Date() } : { cursor: String(cursor) }
        )
        .catch(() => null);
    } finally {
      IntegrationService.crawlingCommentPosts.delete(integration.id);
    }
  }

  async fetchPostComments(
    orgId: string,
    integration: string,
    postId: string,
    cursor?: string,
    forceRefresh = false
  ): Promise<SocialCommentsPage> {
    const getIntegration = await this.getIntegrationById(orgId, integration);

    if (!getIntegration) {
      throw new HttpException('Invalid integration', HttpStatus.NOT_FOUND);
    }

    this.assertCommentIntegrationEnabled(getIntegration);

    if (getIntegration.type !== 'social') {
      throw new HttpException(
        'Comments are only available for social integrations',
        HttpStatus.BAD_REQUEST
      );
    }

    const integrationProvider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (!integrationProvider.fetchComments) {
      throw new HttpException(
        'Comments are not supported for this integration',
        HttpStatus.BAD_REQUEST
      );
    }

    if (
      dayjs(getIntegration?.tokenExpiration).isBefore(dayjs()) ||
      getIntegration.refreshNeeded ||
      forceRefresh
    ) {
      const data = await this._refreshIntegrationService.refresh(
        getIntegration,
        'fetch comments'
      );
      if (!data || !data.accessToken) {
        throw new HttpException(
          'Integration needs to be reconnected',
          HttpStatus.UNAUTHORIZED
        );
      }

      getIntegration.token = data.accessToken;

      if (integrationProvider.refreshWait) {
        await timer(10000);
      }
    }

    try {
      const page = await integrationProvider.fetchComments(
        getIntegration.internalId,
        getIntegration.token,
        postId,
        getIntegration,
        cursor
      );

      // Re-attach comments the platform dropped because they are hidden (e.g.
      // Instagram removes them from /comments), so the UI always lists them —
      // marked hidden — and unhide can find the id again.
      return await this.mergeHiddenComments(getIntegration.id, postId, page);
    } catch (e) {
      if (e instanceof RefreshToken && !forceRefresh) {
        return this.fetchPostComments(orgId, integration, postId, cursor, true);
      }
      throw e;
    }
  }

  private async mergeHiddenComments(
    integrationId: string,
    postId: string,
    page: SocialCommentsPage
  ): Promise<SocialCommentsPage> {
    let stored: Awaited<
      ReturnType<IntegrationRepository['getHiddenComments']>
    > = [];
    try {
      stored = await this._integrationRepository.getHiddenComments(
        integrationId,
        postId
      );
    } catch {
      return page; // persistence is a safety net, never break listing
    }
    if (!stored.length) {
      return page;
    }

    const present = new Set<string>();
    const collect = (list: SocialComment[]) => {
      for (const c of list) {
        present.add(String(c.id));
        collect(c.replies || []);
      }
    };
    collect(page.comments);

    const missing = stored.filter((s) => !present.has(s.commentId));
    if (!missing.length) {
      return page;
    }

    const toComment = (s: (typeof stored)[number]): SocialComment => ({
      id: s.commentId,
      text: s.text || '',
      username: s.username,
      timestamp: s.timestamp,
      likeCount: s.likeCount,
      hidden: true,
      replies: [],
    });

    const topLevel = missing.filter((s) => !s.parentId);
    const replies = missing.filter((s) => s.parentId);
    const comments = [...page.comments];

    // Replies whose parent is present get nested back under it; anything we
    // cannot place (parent also hidden and untracked) stays top-level so it is
    // never lost.
    for (const reply of replies) {
      const parent = comments.find((c) => String(c.id) === reply.parentId);
      if (parent) {
        parent.replies = [...(parent.replies || []), toComment(reply)];
      } else {
        topLevel.push(reply);
      }
    }

    return { ...page, comments: [...comments, ...topLevel.map(toComment)] };
  }

  async replyToComment(
    orgId: string,
    integration: string,
    postId: string,
    parentCommentId: string,
    message: string,
    forceRefresh = false
  ): Promise<{ id: string }> {
    const cleanMessage = typeof message === 'string' ? message.trim() : '';
    const cleanParentCommentId =
      typeof parentCommentId === 'string' ? parentCommentId.trim() : '';

    if (!cleanMessage) {
      throw new HttpException('Message is required', HttpStatus.BAD_REQUEST);
    }

    if (!cleanParentCommentId) {
      throw new HttpException(
        'Parent comment id is required',
        HttpStatus.BAD_REQUEST
      );
    }

    const getIntegration = await this.getIntegrationById(orgId, integration);

    if (!getIntegration) {
      throw new HttpException('Invalid integration', HttpStatus.NOT_FOUND);
    }

    this.assertCommentIntegrationEnabled(getIntegration);

    if (getIntegration.type !== 'social') {
      throw new HttpException(
        'Comments are only available for social integrations',
        HttpStatus.BAD_REQUEST
      );
    }

    const integrationProvider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (
      !integrationProvider.fetchComments ||
      !integrationProvider.replyToComment
    ) {
      throw new HttpException(
        'Comment replies are not supported for this integration',
        HttpStatus.BAD_REQUEST
      );
    }

    const maxLength = Number(integrationProvider.maxLength?.());
    if (
      Number.isFinite(maxLength) &&
      maxLength > 0 &&
      cleanMessage.length > maxLength
    ) {
      throw new HttpException(
        `Message must be ${maxLength} characters or less`,
        HttpStatus.BAD_REQUEST
      );
    }

    if (
      dayjs(getIntegration?.tokenExpiration).isBefore(dayjs()) ||
      getIntegration.refreshNeeded ||
      forceRefresh
    ) {
      const data = await this._refreshIntegrationService.refresh(
        getIntegration,
        'reply to comment'
      );
      if (!data || !data.accessToken) {
        throw new HttpException(
          'Integration needs to be reconnected',
          HttpStatus.UNAUTHORIZED
        );
      }

      getIntegration.token = data.accessToken;

      if (integrationProvider.refreshWait) {
        await timer(10000);
      }
    }

    try {
      // Reply directly and let the platform validate the parent when the reply
      // is posted. The previous pre-scan paged through every comment (and, for
      // providers that fetch nested replies per comment, fired an extra request
      // per comment) only to re-check existence/hidden state that the platform
      // enforces anyway — and its top-level-only lookup could never resolve a
      // nested reply's id, so replying to a reply always failed. On failure the
      // provider surfaces the platform error (RefreshToken retried below).
      const reply = await integrationProvider.replyToComment(
        getIntegration.internalId,
        postId,
        cleanParentCommentId,
        getIntegration.token,
        cleanMessage,
        getIntegration
      );

      return { id: String(reply.id) };
    } catch (e) {
      if (e instanceof RefreshToken && !forceRefresh) {
        return this.replyToComment(
          orgId,
          integration,
          postId,
          cleanParentCommentId,
          cleanMessage,
          true
        );
      }
      throw e;
    }
  }

  async hideComment(
    orgId: string,
    integration: string,
    postId: string,
    commentId: string,
    hidden: boolean,
    forceRefresh = false
  ): Promise<{ id: string; hidden: boolean }> {
    const cleanCommentId =
      typeof commentId === 'string' ? commentId.trim() : '';

    if (!cleanCommentId) {
      throw new HttpException('Comment id is required', HttpStatus.BAD_REQUEST);
    }

    const getIntegration = await this.getIntegrationById(orgId, integration);

    if (!getIntegration) {
      throw new HttpException('Invalid integration', HttpStatus.NOT_FOUND);
    }

    this.assertCommentIntegrationEnabled(getIntegration);

    if (getIntegration.type !== 'social') {
      throw new HttpException(
        'Comments are only available for social integrations',
        HttpStatus.BAD_REQUEST
      );
    }

    const integrationProvider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (!integrationProvider.hideComment) {
      throw new HttpException(
        'Hiding comments is not supported for this integration',
        HttpStatus.BAD_REQUEST
      );
    }

    if (
      dayjs(getIntegration?.tokenExpiration).isBefore(dayjs()) ||
      getIntegration.refreshNeeded ||
      forceRefresh
    ) {
      const data = await this._refreshIntegrationService.refresh(
        getIntegration,
        'hide comment'
      );
      if (!data || !data.accessToken) {
        throw new HttpException(
          'Integration needs to be reconnected',
          HttpStatus.UNAUTHORIZED
        );
      }

      getIntegration.token = data.accessToken;

      if (integrationProvider.refreshWait) {
        await timer(10000);
      }
    }

    try {
      // Snapshot the comment before hiding so it stays listed once the platform
      // drops it (Instagram removes hidden comments from /comments). On unhide,
      // drop the snapshot — the platform returns it again.
      let snapshot: (SocialComment & { parentId?: string }) | undefined;
      if (hidden && integrationProvider.fetchComments) {
        snapshot = await this.findCommentSnapshot(
          getIntegration,
          integrationProvider,
          postId,
          cleanCommentId
        );
      }

      const result = await integrationProvider.hideComment(
        getIntegration.internalId,
        postId,
        cleanCommentId,
        getIntegration.token,
        hidden,
        getIntegration
      );

      if (hidden) {
        await this._integrationRepository
          .saveHiddenComment(getIntegration.id, {
            commentId: cleanCommentId,
            postId,
            parentId: snapshot?.parentId,
            text: snapshot?.text,
            username: snapshot?.username,
            timestamp: snapshot?.timestamp,
            likeCount: snapshot?.likeCount,
          })
          .catch(() => null);
      } else {
        await this._integrationRepository
          .removeHiddenComment(getIntegration.id, cleanCommentId)
          .catch(() => null);
      }

      return result;
    } catch (e) {
      if (e instanceof RefreshToken && !forceRefresh) {
        return this.hideComment(
          orgId,
          integration,
          postId,
          cleanCommentId,
          hidden,
          true
        );
      }
      throw e;
    }
  }

  // Best-effort lookup of a comment (and its parent, for replies) so the stored
  // snapshot keeps text/author. Returns undefined if the comment is not found.
  private async findCommentSnapshot(
    integration: Integration,
    provider: SocialProvider,
    postId: string,
    commentId: string
  ): Promise<(SocialComment & { parentId?: string }) | undefined> {
    try {
      let cursor: string | undefined;
      // Cap the scan so a deep comment can't page forever.
      for (let i = 0; i < 10; i++) {
        const page: SocialCommentsPage = await provider.fetchComments!(
          integration.internalId,
          integration.token,
          postId,
          integration,
          cursor
        );
        const found = this.findInComments(page.comments, commentId);
        if (found) {
          return found;
        }
        if (!page.next) {
          break;
        }
        cursor = page.next;
      }
    } catch {
      // Snapshot is best-effort; hiding must still proceed without it.
    }
    return undefined;
  }

  private findInComments(
    comments: SocialComment[],
    id: string,
    parentId?: string
  ): (SocialComment & { parentId?: string }) | undefined {
    for (const c of comments) {
      if (String(c.id) === id) {
        return { ...c, parentId };
      }
      const inReplies = this.findInComments(c.replies || [], id, String(c.id));
      if (inReplies) {
        return inReplies;
      }
    }
    return undefined;
  }

  /**
   * One flat, newest-first feed of a channel's comments, so a moderator can
   * read what just came in without opening posts one by one.
   *
   * Built on the two reads the post view already does — a page of posts, then
   * each post's comments — rather than a new provider method, so hidden-comment
   * snapshots, token refresh and the TikTok post cache all apply unchanged.
   *
   * A posts page can be far bigger than `limit` (Instagram delivers its whole
   * ad set on the first page) and every post costs a platform request, so the
   * page is ordered by activity and walked `limit` posts at a time; the cursor
   * carries both the posts cursor and the offset into that page. Only the first
   * page of each post's comments is read — a post with more is flagged
   * `truncated` so the screen can say so instead of implying the feed is
   * complete.
   */
  async fetchAllComments(
    orgId: string,
    integration: string,
    limit = 30,
    cursor?: string
  ): Promise<SocialAllCommentsPage> {
    const position = IntegrationService.decodeAllCommentsCursor(cursor);
    const page = await this.fetchCommentPosts(
      orgId,
      integration,
      Math.max(limit, 1),
      position.postsCursor
    );

    // A post known to have no comments costs a request and returns nothing.
    // An unknown count is kept — unknown is not zero (dark posts report none).
    const candidates = orderBy(
      page.posts.filter((post) => post.commentCount !== 0),
      [(post) => post.lastCommentDate || '', 'publishDate'],
      ['desc', 'desc']
    );
    const slice = candidates.slice(position.offset, position.offset + limit);

    const read = await mapLimit(
      slice,
      IntegrationService.ALL_COMMENTS_CONCURRENCY,
      async (post: SocialCommentPost) => {
        try {
          const result = await this.fetchPostComments(
            orgId,
            integration,
            post.id
          );
          return {
            post: { ...post, truncated: !!result.next },
            comments: result.comments,
            failed: false,
          };
        } catch (err) {
          // Named rather than swallowed: the page still answers, but says how
          // many posts are missing from it.
          console.error(
            `[comments] could not read comments for post ${post.id} on integration ${integration}:`,
            err instanceof Error ? err.message : err
          );
          return { post, comments: [], failed: true };
        }
      }
    );

    const comments: SocialAllComment[] = read.flatMap((item) =>
      item.comments.map((comment) => ({ ...comment, post: item.post }))
    );

    const nextOffset = position.offset + slice.length;
    const next =
      nextOffset < candidates.length
        ? IntegrationService.encodeAllCommentsCursor({
            postsCursor: position.postsCursor,
            offset: nextOffset,
          })
        : page.next
        ? IntegrationService.encodeAllCommentsCursor({
            postsCursor: page.next,
            offset: 0,
          })
        : undefined;

    return {
      // Newest first; a comment with no usable date goes last rather than
      // wherever an empty string happens to sort.
      comments: orderBy(
        comments,
        [(comment) => Date.parse(comment.timestamp || '') || 0],
        ['desc']
      ),
      posts: slice.length,
      unreadable: read.filter((item) => item.failed).length,
      syncing: page.syncing,
      hasMore: !!next,
      next,
    };
  }

  /**
   * One timeline across every comment-capable channel in the organization —
   * the "what came in, anywhere" view. Each channel contributes its own
   * activity-ordered feed (see fetchAllComments); the cursor is a map of
   * per-channel cursors so channels page independently and a channel that is
   * exhausted simply drops out.
   *
   * Every channel read is platform requests (posts + comments per post), and
   * the TikTok Business channels alone number over a dozen here, so the result
   * is held for a few minutes per organization: reopening the page is free,
   * and `refresh` is an explicit choice, not a side effect of navigation.
   */
  async fetchOrgComments(
    orgId: string,
    limitPerChannel = 10,
    cursor?: string,
    refresh = false
  ): Promise<OrgCommentsPage> {
    const key = `${orgId}:${limitPerChannel}:${cursor || ''}`;
    const cached = IntegrationService.orgFeedCache.get(key);
    if (
      !refresh &&
      cached &&
      Date.now() - cached.at < IntegrationService.ORG_FEED_TTL_MS
    ) {
      return { ...cached.value, cachedAt: new Date(cached.at).toISOString() };
    }

    const position = IntegrationService.decodeOrgCursor(cursor);
    const all = await this.getIntegrationsList(orgId);
    const channels = all.filter((integration) => {
      if (
        integration.type !== 'social' ||
        integration.disabled ||
        integration.refreshNeeded ||
        integration.inBetweenSteps
      ) {
        return false;
      }
      // On a later page only channels that still have a cursor take part.
      if (cursor && !position[integration.id]) {
        return false;
      }
      try {
        const provider = this._integrationManager.getSocialIntegration(
          integration.providerIdentifier
        );
        return !!provider?.fetchComments && !!provider?.fetchCommentPosts;
      } catch {
        return false;
      }
    });

    const read = await mapLimit(
      channels,
      IntegrationService.ORG_FEED_CHANNEL_CONCURRENCY,
      async (integration: Integration) => {
        try {
          const page = await this.fetchAllComments(
            orgId,
            integration.id,
            limitPerChannel,
            position[integration.id] || undefined
          );
          return { integration, page, error: undefined as string | undefined };
        } catch (err) {
          // One channel down (expired token, throttled platform) must not
          // take the whole feed with it — it is named in `channels` instead.
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[comments] org feed: channel ${integration.id} (${integration.providerIdentifier}) failed:`,
            message
          );
          return { integration, page: undefined, error: message };
        }
      }
    );

    const comments: OrgComment[] = read.flatMap((row) =>
      (row.page?.comments || []).map((comment) => ({
        ...comment,
        integration: {
          id: row.integration.id,
          name: row.integration.name,
          identifier: row.integration.providerIdentifier,
          picture: row.integration.picture || undefined,
        },
      }))
    );

    const nextPosition: Record<string, string> = {};
    for (const row of read) {
      if (row.page?.next) {
        nextPosition[row.integration.id] = row.page.next;
      }
    }
    const next = Object.keys(nextPosition).length
      ? IntegrationService.encodeOrgCursor(nextPosition)
      : undefined;

    const value: OrgCommentsPage = {
      comments: orderBy(
        comments,
        [(comment) => Date.parse(comment.timestamp || '') || 0],
        ['desc']
      ),
      channels: read.map((row) => ({
        id: row.integration.id,
        name: row.integration.name,
        identifier: row.integration.providerIdentifier,
        picture: row.integration.picture || undefined,
        posts: row.page?.posts || 0,
        unreadable: row.page?.unreadable || 0,
        ...(row.page?.syncing ? { syncing: true } : {}),
        ...(row.error ? { error: row.error } : {}),
      })),
      hasMore: !!next,
      next,
    };

    IntegrationService.orgFeedCache.set(key, { at: Date.now(), value });
    // Bounded: one entry per (org, page) is plenty, and pages beyond the first
    // are rarely revisited.
    if (IntegrationService.orgFeedCache.size > 200) {
      const oldest = [...IntegrationService.orgFeedCache.entries()].sort(
        (a, b) => a[1].at - b[1].at
      )[0];
      if (oldest) {
        IntegrationService.orgFeedCache.delete(oldest[0]);
      }
    }

    return value;
  }

  private static readonly orgFeedCache = new Map<
    string,
    { at: number; value: OrgCommentsPage }
  >();
  private static readonly ORG_FEED_TTL_MS = 5 * 60 * 1000;
  // Channels read at once. Each channel is its own burst of platform requests
  // (posts, then up to four comment reads in flight), so two is plenty.
  private static readonly ORG_FEED_CHANNEL_CONCURRENCY = 2;

  private static encodeOrgCursor(position: Record<string, string>): string {
    return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
  }

  private static decodeOrgCursor(cursor?: string): Record<string, string> {
    if (!cursor) {
      return {};
    }
    try {
      const parsed = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8')
      );
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      throw new HttpException('Invalid cursor', HttpStatus.BAD_REQUEST);
    }
  }

  // Posts read in parallel for the channel-wide feed. Meta meters per account
  // and TikTok fetches replies per comment, so this stays small.
  private static readonly ALL_COMMENTS_CONCURRENCY = 4;

  private static encodeAllCommentsCursor(position: {
    postsCursor?: string;
    offset: number;
  }): string {
    return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
  }

  private static decodeAllCommentsCursor(cursor?: string): {
    postsCursor?: string;
    offset: number;
  } {
    if (!cursor) {
      return { offset: 0 };
    }

    try {
      const parsed = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8')
      );
      return {
        postsCursor:
          typeof parsed?.postsCursor === 'string' && parsed.postsCursor
            ? parsed.postsCursor
            : undefined,
        offset: Math.max(Number(parsed?.offset) || 0, 0),
      };
    } catch {
      throw new HttpException('Invalid cursor', HttpStatus.BAD_REQUEST);
    }
  }

  customers(orgId: string) {
    return this._integrationRepository.customers(orgId);
  }

  getPlugsByIntegrationId(org: string, integrationId: string) {
    return this._integrationRepository.getPlugsByIntegrationId(
      org,
      integrationId
    );
  }

  async processInternalPlug(
    data: {
      post: string;
      originalIntegration: string;
      integration: string;
      plugName: string;
      orgId: string;
      delay: number;
      information: any;
    },
    forceRefresh = false
  ): Promise<any> {
    const originalIntegration =
      await this._integrationRepository.getIntegrationById(
        data.orgId,
        data.originalIntegration
      );

    const getIntegration = await this._integrationRepository.getIntegrationById(
      data.orgId,
      data.integration
    );

    if (!getIntegration || !originalIntegration) {
      return;
    }

    const getAllInternalPlugs = this._integrationManager
      .getInternalPlugs(getIntegration.providerIdentifier)
      .internalPlugs.find((p: any) => p.identifier === data.plugName);

    if (!getAllInternalPlugs) {
      return;
    }

    const getSocialIntegration = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    // @ts-ignore
    await getSocialIntegration?.[getAllInternalPlugs.methodName]?.(
      getIntegration,
      originalIntegration,
      data.post,
      data.information
    );

    return;
  }

  async processPlugs(data: {
    plugId: string;
    postId: string;
    delay: number;
    totalRuns: number;
    currentRun: number;
  }) {
    const getPlugById = await this._integrationRepository.getPlug(data.plugId);
    if (!getPlugById) {
      return true;
    }

    const integration = this._integrationManager.getSocialIntegration(
      getPlugById.integration.providerIdentifier
    );

    // @ts-ignore
    const process = await integration[getPlugById.plugFunction](
      getPlugById.integration,
      data.postId,
      JSON.parse(getPlugById.data).reduce((all: any, current: any) => {
        all[current.name] = current.value;
        return all;
      }, {})
    );

    if (process) {
      return true;
    }

    if (data.totalRuns === data.currentRun) {
      return true;
    }

    return false;
  }

  async createOrUpdatePlug(
    orgId: string,
    integrationId: string,
    body: PlugDto
  ) {
    const { activated } = await this._integrationRepository.createOrUpdatePlug(
      orgId,
      integrationId,
      body
    );

    return {
      activated,
    };
  }

  async changePlugActivation(orgId: string, plugId: string, status: boolean) {
    const { id, integrationId, plugFunction } =
      await this._integrationRepository.changePlugActivation(
        orgId,
        plugId,
        status
      );

    return { id };
  }

  async getPlugs(orgId: string, integrationId: string) {
    return this._integrationRepository.getPlugs(orgId, integrationId);
  }

  async loadExisingData(
    methodName: string,
    integrationId: string,
    id: string[]
  ) {
    const exisingData = await this._integrationRepository.loadExisingData(
      methodName,
      integrationId,
      id
    );
    const loadOnlyIds = exisingData.map((p) => p.value);
    return difference(id, loadOnlyIds);
  }

  async findFreeDateTime(
    orgId: string,
    integrationsId?: string
  ): Promise<number[]> {
    const findTimes = await this._integrationRepository.getPostingTimes(
      orgId,
      integrationsId
    );
    return uniq(
      findTimes.reduce((all: any, current: any) => {
        return [
          ...all,
          ...JSON.parse(current.postingTimes).map(
            (p: { time: number }) => p.time
          ),
        ];
      }, [] as number[])
    );
  }
}
