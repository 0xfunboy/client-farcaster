import {
  composeContext,
  elizaLogger,
  generateText,
  ModelClass,
  type IAgentRuntime,
  stringToUuid,
} from "@elizaos/core";
import type { ClientBase } from "./base";
import { getFarcasterQueueKey, type FarcasterQueueItem } from "./farcasterQueue";
import { jitterMs, nowTs, readJsonFile, resolvePackagePath, splitCastText, writeJsonFile } from "./utils";
import type { QueueItem, QueueState, RateLimitSnapshot } from "./types";

const queueFile = resolvePackagePath("src", "plugins", "postNewsJSON", "postQueueState.json");
const rateStateFile = resolvePackagePath("src", "plugins", "postNewsJSON", "rateLimitState.json");
const postedNewsFile = resolvePackagePath("src", "plugins", "postNewsJSON", "postedNewsState.json");

const defaultQueueState: QueueState = { version: 1, items: [] };
const defaultRateState: RateLimitSnapshot = { version: 1, postedAt: [] };
const defaultPostedNewsState = { lastReset: 0, posted: [] as string[] };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type NewsEntry = { title: string; link: string };

function parseSimpleRss(xml: string): NewsEntry[] {
  const items: NewsEntry[] = [];
  const matches = xml.matchAll(/<item>([\s\S]*?)<\/item>/gi);
  for (const m of matches) {
    const block = m[1] || "";
    const title = (block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
    const link = (block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "").trim();
    if (title && link) items.push({ title, link });
  }
  return items;
}

class FarcasterRateLimiter {
  private snapshot: RateLimitSnapshot;

  constructor() {
    this.snapshot = readJsonFile<RateLimitSnapshot>(rateStateFile, defaultRateState);
  }

  private prune(now: number): void {
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    this.snapshot.postedAt = this.snapshot.postedAt.filter((ts) => ts >= oneDayAgo);
  }

  canPost(now: number, perHour: number, perDay: number): { ok: boolean; reason?: string } {
    this.prune(now);
    const oneHourAgo = now - 60 * 60 * 1000;
    const inHour = this.snapshot.postedAt.filter((ts) => ts >= oneHourAgo).length;
    const inDay = this.snapshot.postedAt.length;

    if (inHour >= perHour) {
      return { ok: false, reason: `hour quota reached (${inHour}/${perHour})` };
    }
    if (inDay >= perDay) {
      return { ok: false, reason: `day quota reached (${inDay}/${perDay})` };
    }
    return { ok: true };
  }

  nextAllowedAt(now: number, perHour: number, perDay: number): number {
    this.prune(now);
    const oneHourAgo = now - 60 * 60 * 1000;
    const inHour = this.snapshot.postedAt.filter((ts) => ts >= oneHourAgo).sort((a, b) => a - b);
    const inDay = [...this.snapshot.postedAt].sort((a, b) => a - b);

    let nextAt = now;
    if (inHour.length >= perHour) {
      const hourAnchor = inHour[inHour.length - perHour];
      if (Number.isFinite(hourAnchor)) {
        nextAt = Math.max(nextAt, hourAnchor + 60 * 60 * 1000 + 1_000);
      }
    }
    if (inDay.length >= perDay) {
      const dayAnchor = inDay[inDay.length - perDay];
      if (Number.isFinite(dayAnchor)) {
        nextAt = Math.max(nextAt, dayAnchor + 24 * 60 * 60 * 1000 + 1_000);
      }
    }
    return nextAt;
  }

  trackPost(now: number): void {
    this.prune(now);
    this.snapshot.postedAt.push(now);
    writeJsonFile(rateStateFile, this.snapshot);
  }
}

export class FarcasterPostClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  private queueState: QueueState;
  private limiter: FarcasterRateLimiter;
  private running = false;
  private draining = false;
  private immediateDrainTimer: NodeJS.Timeout | null = null;
  private lastCastRequestAt = 0;
  private castBackoffUntil = 0;
  private quotaBackoffUntil = 0;
  private lastQuotaWarnAt = 0;

  constructor(client: ClientBase, runtime: IAgentRuntime) {
    this.client = client;
    this.runtime = runtime;
    this.queueState = readJsonFile<QueueState>(queueFile, defaultQueueState);
    this.limiter = new FarcasterRateLimiter();
  }

  private saveQueue(): void {
    writeJsonFile(queueFile, this.queueState);
  }

  private priority(item: QueueItem): number {
    return item.kind === "news"
      ? this.client.farcasterConfig.FARCASTER_NEWS_PRIORITY_WEIGHT
      : this.client.farcasterConfig.FARCASTER_TRADE_PRIORITY_WEIGHT;
  }

  enqueue(item: Omit<QueueItem, "id" | "createdAt">): void {
    const sourceId = typeof item.metadata?.sourceId === "string" ? String(item.metadata.sourceId) : undefined;
    if (sourceId && this.queueState.items.some((x) => x.metadata?.sourceId === sourceId)) {
      return;
    }

    if (this.queueState.items.length >= this.client.farcasterConfig.FARCASTER_QUEUE_MAX_SIZE) {
      elizaLogger.warn("[Farcaster] queue full, dropping oldest trade to preserve queue health");
      const idx = this.queueState.items.findIndex((x) => x.kind === "trade");
      if (idx >= 0) this.queueState.items.splice(idx, 1);
      else this.queueState.items.shift();
    }

    this.queueState.items.push({
      ...item,
      id: `${item.kind}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
      createdAt: nowTs(),
    });
    this.saveQueue();

    elizaLogger.info(`[Farcaster] queued ${item.kind} post`);
    this.scheduleImmediateDrain();
  }

  private scheduleImmediateDrain(): void {
    if (!this.running) return;
    if (this.immediateDrainTimer) return;
    this.immediateDrainTimer = setTimeout(async () => {
      this.immediateDrainTimer = null;
      try {
        await this.drainQueueOnce();
      } catch (error) {
        elizaLogger.warn("[Farcaster] immediate queue drain failed", error);
      }
    }, 1_500);
  }

  private nextItem(): QueueItem | null {
    if (!this.queueState.items.length) return null;
    const sorted = [...this.queueState.items].sort((a, b) => {
      const byPriority = this.priority(b) - this.priority(a);
      if (byPriority !== 0) return byPriority;
      return a.createdAt - b.createdAt;
    });
    return sorted[0] || null;
  }

  private removeQueueItem(id: string): void {
    this.queueState.items = this.queueState.items.filter((x) => x.id !== id);
    this.saveQueue();
  }

  private async maybeEnqueueNewsFromFeed(): Promise<void> {
    const rssUrl = this.client.farcasterConfig.FARCASTER_FEED_RSS_URL;
    if (!rssUrl) return;

    try {
      const response = await fetch(rssUrl);
      if (!response.ok) throw new Error(`RSS fetch failed: ${response.status}`);
      const xml = await response.text();
      const entries = parseSimpleRss(xml);
      if (!entries.length) return;

      const state = readJsonFile(postedNewsFile, defaultPostedNewsState);
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      if (!state.lastReset || state.lastReset < oneDayAgo) {
        state.lastReset = Date.now();
        state.posted = [];
      }

      const next = entries.find((x) => !state.posted.includes(x.link));
      if (!next) return;

      this.enqueue({
        kind: "news",
        text: `${next.title}\n\n${next.link}`.slice(0, 1500),
        metadata: { link: next.link },
      });

      state.posted.push(next.link);
      writeJsonFile(postedNewsFile, state);
    } catch (error) {
      elizaLogger.warn("[Farcaster] RSS pipeline failed", error);
    }
  }

  private normalizeSharedKind(kind?: string): "news" | "trade" {
    return kind === "trade" ? "trade" : "news";
  }

  private inferKindFromShared(item: FarcasterQueueItem): "news" | "trade" {
    if (item.kind === "trade") return "trade";
    const content = (item.content || "").toLowerCase();
    if (
      content.includes("trade setup") ||
      content.includes("most mentioned ticker") ||
      content.includes("increasing mentions") ||
      content.includes("entry") ||
      content.includes("stop loss") ||
      content.includes("take profit")
    ) {
      return "trade";
    }
    return this.normalizeSharedKind(item.kind);
  }

  private async importSharedQueue(): Promise<void> {
    const cache = this.runtime.cacheManager;
    if (!cache) return;

    const queueKey = getFarcasterQueueKey(this.runtime);
    const sharedQueue = (await cache.get<FarcasterQueueItem[]>(queueKey)) || [];
    if (!sharedQueue.length) return;

    let imported = 0;

    for (const item of sharedQueue) {
      if (!item?.content?.trim()) continue;
      const sourceId = String(item.id || "");
      if (!sourceId) continue;
      if (this.queueState.items.some((x) => x.metadata?.sourceId === sourceId)) continue;

      this.enqueue({
        kind: this.inferKindFromShared(item),
        text: item.content.trim().slice(0, 1500),
        parentHash: item.parentHash,
        metadata: {
          source: "shared",
          sourceId,
          priority: !!item.priority,
          embedUrl: item.embedUrl || "",
        },
      });
      imported += 1;
    }

    await cache.set(queueKey, []);

    if (imported > 0) {
      elizaLogger.info(`[Farcaster] imported ${imported} shared post(s) from sink queue`);
    }
  }

  private async postItem(item: QueueItem): Promise<boolean> {
    const now = nowTs();
    if (now < this.quotaBackoffUntil) {
      return false;
    }

    const allowed = this.limiter.canPost(
      now,
      this.client.farcasterConfig.FARCASTER_MAX_POSTS_PER_HOUR,
      this.client.farcasterConfig.FARCASTER_MAX_POSTS_PER_DAY
    );

    if (!allowed.ok) {
      const nextAt = this.limiter.nextAllowedAt(
        now,
        this.client.farcasterConfig.FARCASTER_MAX_POSTS_PER_HOUR,
        this.client.farcasterConfig.FARCASTER_MAX_POSTS_PER_DAY
      );
      this.quotaBackoffUntil = Math.max(this.quotaBackoffUntil, nextAt);
      // Avoid log spam while queue is blocked by quota.
      if (now - this.lastQuotaWarnAt >= 10 * 60 * 1000) {
        const waitSec = Math.max(1, Math.ceil((this.quotaBackoffUntil - now) / 1000));
        elizaLogger.warn(
          `[Farcaster] ${item.kind} queued due to rate limit: ${allowed.reason}; retry in ~${waitSec}s`
        );
        this.lastQuotaWarnAt = now;
      }
      return false;
    }

    const platformMax = this.client.farcasterConfig.FARCASTER_PROTOCOL_PRO ? 1024 : 300;
    const maxCastLength = Math.max(
      120,
      Math.min(platformMax, this.client.farcasterConfig.FARCASTER_MAX_CAST_LENGTH)
    );
    const chunks = splitCastText(item.text, maxCastLength);
    let parent = item.parentHash;
    const embedUrl = typeof item.metadata?.embedUrl === "string" ? item.metadata.embedUrl : undefined;
    const embeds = embedUrl ? [embedUrl] : undefined;
    if (embedUrl) {
      elizaLogger.info("[Farcaster] attaching embed image from approval message");
    }

    for (let i = 0; i < chunks.length; i += 1) {
      const nowBeforeRequest = Date.now();
      const minSpacing = this.client.farcasterConfig.FARCASTER_CAST_REQUEST_MIN_INTERVAL_MS;
      const waitForSpacing = Math.max(0, this.lastCastRequestAt + minSpacing - nowBeforeRequest);
      const waitForBackoff = Math.max(0, this.castBackoffUntil - nowBeforeRequest);
      const waitMs = Math.max(waitForSpacing, waitForBackoff);
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      const chunk = chunks[i];
      let cast;
      try {
        cast = parent
          ? await this.client.replyTo(parent, chunk)
          : await this.client.postStatus(chunk, i === 0 ? { embeds } : undefined);
      } catch (error: any) {
        const status = error?.status || error?.response?.status;
        if (status === 429) {
          const retryAfterRaw =
            error?.response?.headers?.["retry-after"] ??
            error?.response?.headers?.["Retry-After"];
          const retryAfterMs =
            retryAfterRaw && Number.isFinite(Number(retryAfterRaw))
              ? Number(retryAfterRaw) * 1_000
              : 45_000;
          this.castBackoffUntil = Date.now() + Math.max(15_000, retryAfterMs);
          elizaLogger.warn(
            `[Farcaster] cast publish rate-limited, backing off for ${Math.ceil(
              Math.max(15_000, retryAfterMs) / 1000
            )}s`
          );
          return false;
        }
        throw error;
      }
      this.lastCastRequestAt = Date.now();
      parent = cast.hash;
      this.limiter.trackPost(Date.now());
      elizaLogger.info(`[Farcaster] cast published hash=${cast.hash} kind=${item.kind}`);

      // Persist incremental progress so a restart or 429 resumes from the next chunk.
      item.parentHash = parent;
      if (i < chunks.length - 1) {
        item.text = chunks.slice(i + 1).join("\n\n");
      }
      this.saveQueue();
    }

    this.removeQueueItem(item.id);
    elizaLogger.info(`[Farcaster] posted ${item.kind}`);
    return true;
  }

  private async buildTradeCastText(seedText: string): Promise<string> {
    const roomId = stringToUuid(`farcaster-trade:${this.runtime.agentId}`);
    const state = await this.runtime.composeState(
      {
        roomId,
        userId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        content: { text: seedText, action: "" },
      } as any,
      {
        farcasterUsername: this.client.profile?.username || "agent",
        currentPost: seedText,
      }
    );

    const context = composeContext({
      state,
      template:
        this.runtime.character.templates?.farcasterTradeTemplate ||
        "Rewrite the input as one sharp market update in Bairbi voice, max 800 chars, high signal, no spam.\nInput:\n{{currentPost}}",
    });

    const generated = await generateText({
      runtime: this.runtime,
      context,
      modelClass: ModelClass.SMALL,
    });

    const text = (generated || seedText).trim();
    return text.slice(0, 1500);
  }

  async generateNewTweetForMostMentionedTicker(prefix: string, _chartBase64?: string): Promise<void> {
    const text = await this.buildTradeCastText(prefix);
    this.enqueue({ kind: "trade", text });
  }

  async generateNewTweetForAutotradingTicker(prefix: string, _chartBase64?: string): Promise<void> {
    const text = await this.buildTradeCastText(prefix);
    this.enqueue({ kind: "trade", text });
  }

  async generateNewTweet(): Promise<void> {
    const roomId = stringToUuid(`farcaster-news:${this.runtime.agentId}`);
    const state = await this.runtime.composeState(
      {
        roomId,
        userId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        content: { text: "", action: "" },
      } as any,
      {
        farcasterUsername: this.client.profile?.username || "agent",
      }
    );

    const context = composeContext({
      state,
      template:
        this.runtime.character.templates?.farcasterPostTemplate ||
        "Write one concise news-style update in the voice of {{agentName}} with no hashtags.",
    });

    const text = await generateText({
      runtime: this.runtime,
      context,
      modelClass: ModelClass.SMALL,
    });

    if (text?.trim()) {
      this.enqueue({ kind: "news", text: text.trim().slice(0, 1500) });
    }
  }

  private async drainQueueOnce(): Promise<void> {
    if (this.draining) return;
    if (Date.now() < this.quotaBackoffUntil) return;
    this.draining = true;
    const next = this.nextItem();
    try {
      if (!next) return;
      await this.postItem(next);
    } finally {
      this.draining = false;
    }
  }

  async start(): Promise<void> {
    const loop = async () => {
      try {
        if (this.client.farcasterConfig.FARCASTER_SINK_MODE) {
          await this.importSharedQueue();
        } else {
          await this.maybeEnqueueNewsFromFeed();
        }

        if (
          this.queueState.items.length === 0 &&
          !this.client.farcasterConfig.FARCASTER_SINK_MODE &&
          this.client.farcasterConfig.FARCASTER_ENABLE_AUTONOMOUS_POST_GENERATION
        ) {
          await this.generateNewTweet();
        }

        await this.drainQueueOnce();
      } catch (error) {
        elizaLogger.error("[Farcaster] post loop error", error);
      } finally {
        const now = Date.now();
        const quotaWait = Math.max(0, this.quotaBackoffUntil - now);
        const delay =
          quotaWait > 0
            ? Math.min(quotaWait, 15 * 60 * 1000)
            : this.queueState.items.length > 0
              ? 15_000
              : jitterMs(
                  this.client.farcasterConfig.FARCASTER_POST_INTERVAL_MIN_MS,
                  this.client.farcasterConfig.FARCASTER_POST_INTERVAL_MAX_MS
                );
        setTimeout(loop, delay);
      }
    };

    if (!this.running) {
      this.running = true;
      await loop();
    }
  }
}

// alias per compat con plugin copy-paste dal client-twitter
export const TwitterPostClient = FarcasterPostClient;

export function __testOnly_createRateLimiter() {
  return new FarcasterRateLimiter();
}
