import {
  composeContext,
  elizaLogger,
  generateMessageResponse,
  generateShouldRespond,
  getEmbeddingZeroVector,
  ModelClass,
  stringToUuid,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import type { ClientBase } from "./base";
import { jitterMs, readJsonFile, resolvePackagePath, writeJsonFile } from "./utils";
import { farcasterMessageHandlerTemplate, farcasterShouldRespondTemplate } from "./templates";
import type { FarcasterCast, InteractionState } from "./types";

const interactionStatePath = resolvePackagePath("src", "plugins", "postNewsJSON", "interactionState.json");
const defaultState: InteractionState = {
  version: 1,
  lastMentionsCursor: undefined,
  lastRepliesCursorByHash: {},
  lastRepliesFetchAt: 0,
  processed: {},
};

export class FarcasterInteractionClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  private targetFidCache: Record<string, number> = {};
  private topicSearchEnabled = true;
  private repliesBackoffUntil = 0;
  private replyFetchWindow: number[] = [];

  constructor(client: ClientBase, runtime: IAgentRuntime) {
    this.client = client;
    this.runtime = runtime;
  }

  private summarizeError(error: any): string {
    const status = error?.status || error?.response?.status;
    const message = error?.response?.data?.message || error?.message || "unknown error";
    return status ? `status=${status} ${message}` : String(message);
  }

  private loadState(): InteractionState {
    return readJsonFile(interactionStatePath, defaultState);
  }

  private saveState(state: InteractionState): void {
    writeJsonFile(interactionStatePath, state);
  }

  private pruneProcessed(state: InteractionState): void {
    const ttl = this.client.farcasterConfig.FARCASTER_PROCESSED_MESSAGE_TTL_MS;
    const threshold = Date.now() - ttl;
    Object.keys(state.processed).forEach((id) => {
      if (state.processed[id] < threshold) delete state.processed[id];
    });
  }

  private alreadyProcessed(state: InteractionState, id: string): boolean {
    return !!state.processed[id];
  }

  private markProcessed(state: InteractionState, id: string): void {
    state.processed[id] = Date.now();
  }

  private canFetchReplies(now: number): boolean {
    this.replyFetchWindow = this.replyFetchWindow.filter((ts) => now - ts < 60_000);
    if (now < this.repliesBackoffUntil) return false;
    // Keep below FREE cap (6/60s) with a safety margin
    return this.replyFetchWindow.length < 5;
  }

  private trackRepliesFetch(now: number): void {
    this.replyFetchWindow.push(now);
  }

  private shouldIgnoreAuthor(cast: FarcasterCast): boolean {
    if (cast.authorFid === this.client.farcasterConfig.FARCASTER_FID) return true;
    if (!this.client.farcasterConfig.FARCASTER_IGNORE_BOT_AUTHORS) return false;
    const user = (cast.authorUsername || "").toLowerCase();
    return user.includes("bot") || user.endsWith(".eth");
  }

  private async replyToCast(cast: FarcasterCast, text: string): Promise<void> {
    if (!text.trim()) return;

    const roomId = stringToUuid(`${cast.parentHash || cast.hash}-${this.runtime.agentId}`);
    const userId = stringToUuid(cast.authorFid.toString());

    await this.runtime.ensureConnection(
      userId,
      roomId,
      cast.authorUsername,
      cast.authorDisplayName,
      "farcaster"
    );

    const incomingMemoryId = stringToUuid(`${cast.hash}-${this.runtime.agentId}`);
    const incomingMemory: Memory = {
      id: incomingMemoryId,
      agentId: this.runtime.agentId,
      userId,
      roomId,
      content: {
        text: cast.text,
        source: "farcaster",
        hash: cast.hash,
      },
      embedding: getEmbeddingZeroVector(),
    };

    const state = await this.runtime.composeState(incomingMemory, {
      farcasterUsername: this.client.profile?.username || "agent",
      currentPost: cast.text,
      formattedConversation: cast.text,
    });

    const shouldContext = composeContext({
      state,
      template:
        this.runtime.character.templates?.farcasterShouldRespondTemplate ||
        farcasterShouldRespondTemplate,
    });

    const should = await generateShouldRespond({
      runtime: this.runtime,
      context: shouldContext,
      modelClass: ModelClass.SMALL,
    });

    if (should === "IGNORE" || should === "STOP") return;

    const messageContext = composeContext({
      state,
      template:
        this.runtime.character.templates?.farcasterMessageHandlerTemplate ||
        farcasterMessageHandlerTemplate,
    });

    const response = await generateMessageResponse({
      runtime: this.runtime,
      context: messageContext,
      modelClass: ModelClass.MEDIUM,
    });

    const replyText = response?.text?.trim() || text;
    const sent = await this.client.replyTo(cast.hash, replyText.slice(0, 1024));

    await this.runtime.messageManager.createMemory(incomingMemory);
    await this.runtime.messageManager.createMemory({
      id: stringToUuid(`${sent.hash}-${this.runtime.agentId}`),
      agentId: this.runtime.agentId,
      userId: this.runtime.agentId,
      roomId,
      content: {
        text: sent.text,
        source: "farcaster",
        hash: sent.hash,
        inReplyTo: incomingMemoryId,
      },
      embedding: getEmbeddingZeroVector(),
    });
  }

  async handleFarcasterInteractions(): Promise<void> {
    const state = this.loadState();
    this.pruneProcessed(state);

    if (!this.client.farcasterConfig.ENABLE_ACTION_PROCESSING) {
      this.saveState(state);
      return;
    }

    let mentions: { items: FarcasterCast[]; nextCursor?: string } = { items: [] };
    try {
      mentions = await this.client.api.getMentions(
        this.client.farcasterConfig.FARCASTER_FID,
        state.lastMentionsCursor
      );
    } catch (error) {
      elizaLogger.warn(`[Farcaster] mentions fetch failed: ${this.summarizeError(error)}`);
    }

    if (mentions.nextCursor) {
      state.lastMentionsCursor = mentions.nextCursor;
    }

    let recent: { items: FarcasterCast[]; nextCursor?: string } = { items: [] };
    try {
      recent = await this.client.api.getMyRecentCasts(this.client.farcasterConfig.FARCASTER_FID);
    } catch (error) {
      elizaLogger.warn("[Farcaster] recent casts fetch failed", error);
    }
    const candidates: FarcasterCast[] = [...mentions.items];

    // Target users by username -> fid
    for (const username of this.client.farcasterConfig.FARCASTER_TARGET_USERS) {
      if (
        this.client.profile?.username &&
        username.toLowerCase() === this.client.profile.username.toLowerCase()
      ) {
        continue;
      }
      if (!this.targetFidCache[username]) {
        try {
          const fid = await this.client.api.lookupUserFidByUsername(username);
          if (fid) this.targetFidCache[username] = fid;
      } catch (error) {
        elizaLogger.warn(
          `[Farcaster] target user resolve failed: ${username} ${this.summarizeError(error)}`
        );
      }
      }
    }

    const targetFids = new Set<number>([
      ...this.client.farcasterConfig.FARCASTER_TARGET_FIDS,
      ...Object.values(this.targetFidCache),
    ]);

    for (const fid of targetFids) {
      try {
        const targetCasts = await this.client.api.getMyRecentCasts(fid);
        candidates.push(...targetCasts.items.slice(0, this.client.farcasterConfig.MAX_ACTIONS_PROCESSING));
      } catch (error) {
        elizaLogger.warn(`[Farcaster] target fid fetch failed: ${fid} ${this.summarizeError(error)}`);
      }
    }

    // Target topics
    if (this.topicSearchEnabled) {
      for (const topic of this.client.farcasterConfig.FARCASTER_TARGET_TOPICS) {
        try {
          const found = await this.client.api.searchCasts(topic, this.client.farcasterConfig.MAX_ACTIONS_PROCESSING);
          candidates.push(...found);
        } catch (error: any) {
          const status = error?.status || error?.response?.status;
          if (status === 402) {
            this.topicSearchEnabled = false;
            elizaLogger.warn("[Farcaster] topic search disabled: Neynar paid-plan endpoint (402)");
            break;
          }
          elizaLogger.warn(
            `[Farcaster] topic search failed: ${topic} ${this.summarizeError(error)}`
          );
        }
      }
    }

    const maxReplyFetchesPerTick = Math.max(
      0,
      this.client.farcasterConfig.FARCASTER_REPLY_FETCH_CASTS_PER_TICK
    );
    const repliesMinIntervalMs = Math.max(
      1_000,
      this.client.farcasterConfig.FARCASTER_REPLIES_MIN_INTERVAL_MS
    );
    let replyFetchCount = 0;

    for (const mine of recent.items) {
      if (replyFetchCount >= maxReplyFetchesPerTick) break;

      const lastFetchAt = state.lastRepliesFetchAt || 0;
      const now = Date.now();
      if (now - lastFetchAt < repliesMinIntervalMs) break;
      if (!this.canFetchReplies(now)) break;

      const replyCursor = state.lastRepliesCursorByHash[mine.hash];
      try {
        this.trackRepliesFetch(Date.now());
        const replies = await this.client.api.getReplies(mine.hash, replyCursor);
        state.lastRepliesFetchAt = Date.now();
        replyFetchCount += 1;
        if (replies.nextCursor) state.lastRepliesCursorByHash[mine.hash] = replies.nextCursor;
        candidates.push(...replies.items);
      } catch (error: any) {
        state.lastRepliesFetchAt = Date.now();
        replyFetchCount += 1;
        const status = error?.status || error?.response?.status;
        if (status === 429) {
          this.repliesBackoffUntil = Date.now() + 70_000;
        }
        elizaLogger.warn(
          `[Farcaster] replies fetch failed for cast ${mine.hash}: ${this.summarizeError(error)}`
        );
      }
    }

    let processedCount = 0;
    for (const cast of candidates) {
      if (this.shouldIgnoreAuthor(cast)) continue;
      if (this.alreadyProcessed(state, cast.hash)) continue;
      if (processedCount >= this.client.farcasterConfig.MAX_ACTIONS_PROCESSING) break;

      try {
        await this.replyToCast(cast, cast.text);
        processedCount += 1;
      } catch (error) {
        elizaLogger.warn(
          `[Farcaster] failed replying to cast ${cast.hash}: ${this.summarizeError(error)}`
        );
      }

      this.markProcessed(state, cast.hash);
    }

    this.saveState(state);
  }

  async start(): Promise<void> {
    const loop = async () => {
      try {
        await this.handleFarcasterInteractions();
      } catch (error) {
        elizaLogger.error("[Farcaster] interactions loop error", error);
      } finally {
        const actionMs = this.client.farcasterConfig.ACTION_INTERVAL * 60 * 1000;
        const delay = jitterMs(
          Math.max(this.client.farcasterConfig.FARCASTER_INTERACTIONS_INTERVAL_MIN_MS, actionMs),
          Math.max(this.client.farcasterConfig.FARCASTER_INTERACTIONS_INTERVAL_MAX_MS, actionMs)
        );
        setTimeout(loop, delay);
      }
    };

    await loop();
  }
}

// alias naming parity
export const TwitterInteractionClient = FarcasterInteractionClient;
