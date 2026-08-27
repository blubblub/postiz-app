/**
 * Keeps the Meta ad walk off the comment screen's critical path.
 *
 * `fetchMetaAds` now reads every ad account to exhaustion, which on a business
 * with dozens of them is 100+ requests and 11-30 seconds. That cannot run
 * synchronously on a screen load, and the previous answer — race it against a
 * timeout and return `[]` when it loses — is worse than useless here: it turns
 * "we read everything" back into "we read nothing", silently, exactly the
 * failure this whole change exists to remove.
 *
 * So a walk is started, waited on only briefly, and then left to finish in the
 * background and fill the cache. A screen load gets one of three things:
 *
 * - a cached walk, instantly;
 * - a fresh walk, if the account is small enough to finish inside `waitMs`
 *   (which is most of them, and is what happened before this cache existed);
 * - nothing yet, plus `complete: false`, so the caller can tell the screen it
 *   is still syncing rather than implying there are no ads.
 *
 * The walk is never cancelled when the wait expires — it is the thing filling
 * the cache for the next load.
 */
export type CachedWalk<T> = {
  value?: T;
  /** False while a first walk for this key is still running. */
  complete: boolean;
};

type CacheEntry<T> = { value: T; at: number; ttlMs: number };

export class MetaAdsCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly failedAt = new Map<string, number>();

  constructor(
    /** How long a completed walk is served before another one is started. */
    private readonly ttlMs = 15 * 60 * 1000,
    /** How long a screen load waits for a walk before giving up on it. */
    private readonly waitMs = 8000,
    /** How long a failed walk is left alone, so a dead token isn't hammered. */
    private readonly cooldownMs = 60 * 1000,
    /** Bound on retained walks — one entry per connected channel. */
    private readonly maxEntries = 100,
    /**
     * Incomplete values (an ad walk that could not read every account) are
     * still served, but only for `cooldownMs`, and they must not replace a
     * complete one. The hour-long TTL is for a finished walk, not a partial.
     */
    private readonly isComplete?: (value: T) => boolean
  ) {}

  async read(key: string, load: () => Promise<T>): Promise<CachedWalk<T>> {
    const entry = this.entries.get(key);

    if (entry && this.isFresh(entry)) {
      return { value: entry.value, complete: true };
    }

    const walk = this.refresh(key, load);

    // Only a cold cache is worth waiting for. A previous walk is a complete
    // answer even while it is being refreshed, and serving it at once beats
    // making one unlucky visitor per TTL sit through the wait.
    if (entry) {
      return { value: entry.value, complete: true };
    }

    if (walk) {
      await MetaAdsCache.raceTimeout(walk, this.waitMs);
    }

    const settled = this.entries.get(key);

    return { value: settled?.value, complete: !!settled };
  }

  /**
   * Like `read`, but a cold cache waits for the walk however long it takes.
   *
   * For caches nested inside another cache's background refresh, where there is
   * no screen load to keep waiting and returning half an answer would poison
   * the outer cache with an empty result.
   */
  async readBlocking(
    key: string,
    load: () => Promise<T>
  ): Promise<CachedWalk<T>> {
    const entry = this.entries.get(key);

    if (entry && this.isFresh(entry)) {
      return { value: entry.value, complete: true };
    }

    await this.refresh(key, load);

    const settled = this.entries.get(key) ?? entry;

    return { value: settled?.value, complete: !!settled };
  }

  /**
   * Resolves once no walk is running. Only the checks need this — production
   * deliberately never waits for a walk to finish.
   */
  async settle(): Promise<void> {
    while (this.inFlight.size) {
      await Promise.all([...this.inFlight.values()]);
    }
  }

  clear(): void {
    this.entries.clear();
    this.failedAt.clear();
  }

  /**
   * Starts a walk unless one is already running for this key, and returns it so
   * a caller can wait on the same walk instead of starting a second.
   */
  private refresh(key: string, load: () => Promise<T>): Promise<unknown> | undefined {
    const running = this.inFlight.get(key);
    if (running) {
      return running;
    }

    const failed = this.failedAt.get(key);
    if (failed !== undefined && Date.now() - failed < this.cooldownMs) {
      return undefined;
    }

    const walk = load()
      .then((value) => {
        this.failedAt.delete(key);
        const complete = !this.isComplete || this.isComplete(value);
        const existing = this.entries.get(key);

        if (
          !complete &&
          existing &&
          (!this.isComplete || this.isComplete(existing.value))
        ) {
          // Same rule as a thrown walk: a partial must not replace ads we
          // already read in full. Retry after the cooldown.
          this.failedAt.set(key, Date.now());
          return;
        }

        this.entries.set(key, {
          value,
          at: Date.now(),
          ttlMs: complete ? this.ttlMs : this.cooldownMs,
        });
        this.evict();
      })
      .catch(() => {
        // A failed walk must not overwrite a good one: an ads listing is
        // optional, and losing it to one blip would look like the ads had
        // disappeared. Cool down instead, so every screen load doesn't restart
        // a walk that is going to fail again.
        this.failedAt.set(key, Date.now());
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, walk);

    return walk;
  }

  private isFresh(entry: CacheEntry<T>): boolean {
    return Date.now() - entry.at < entry.ttlMs;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;

      for (const [key, entry] of this.entries) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = key;
        }
      }

      if (!oldestKey) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }

  /**
   * Waits for `promise`, but not longer than `ms`. The timeout is cleared
   * either way — a pending timer would hold the process open long after the
   * response it was bounding has been sent.
   */
  private static async raceTimeout(
    promise: Promise<unknown>,
    ms: number
  ): Promise<void> {
    let handle: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, ms);
    });

    try {
      await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(handle);
    }
  }
}
