import { Configuration, NeynarAPIClient, NeynarHubClient, isApiErrorResponse } from "@neynar/nodejs-sdk";
import type { IAgentRuntime } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import type { FarcasterCast, FarcasterProfile } from "./types";
import type { FarcasterConfig } from "./environment";
import { sanitizeForLog } from "./utils";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(fn: () => Promise<T>, retries = 4): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const status = error?.status || error?.response?.status || error?.response?.data?.statusCode;

      if (status === 401 || status === 403) {
        throw error;
      }

      if (attempt >= retries) break;

      const retryAfterRaw =
        error?.response?.headers?.["retry-after"] ??
        error?.response?.headers?.["Retry-After"];
      const retryAfterMs =
        retryAfterRaw && Number.isFinite(Number(retryAfterRaw))
          ? Number(retryAfterRaw) * 1_000
          : 0;
      const waitMs =
        status === 429
          ? Math.max(retryAfterMs, (attempt + 1) * 10_000)
          : (300 + Math.floor(Math.random() * 700)) * (attempt + 1);
      await sleep(waitMs);
      attempt += 1;
    }
  }

  throw lastError;
}

function mapCast(cast: any): FarcasterCast {
  return {
    hash: cast.hash,
    text: cast.text || "",
    authorFid: cast.author?.fid,
    authorUsername: cast.author?.username,
    authorDisplayName: cast.author?.display_name,
    timestamp: cast.timestamp,
    parentHash: cast.parent_hash || undefined,
    parentAuthorFid: cast.parent_author?.fid,
  };
}

const FARCASTER_EPOCH_MS = Date.UTC(2021, 0, 1, 0, 0, 0);
function fromHubTimestampToIso(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return new Date().toISOString();
  return new Date(FARCASTER_EPOCH_MS + ts * 1000).toISOString();
}

function mapHubCast(cast: any): FarcasterCast {
  return {
    hash: cast?.hash || "",
    text: cast?.data?.castAddBody?.text || "",
    authorFid: cast?.data?.fid,
    timestamp: fromHubTimestampToIso(cast?.data?.timestamp),
    parentHash: cast?.data?.castAddBody?.parentCastId?.hash,
    parentAuthorFid: cast?.data?.castAddBody?.parentCastId?.fid,
  };
}

export class FarcasterApiClient {
  private neynar: NeynarAPIClient;
  private hub: NeynarHubClient;
  private signerUuid: string;
  private config: FarcasterConfig;

  constructor(config: FarcasterConfig) {
    this.config = config;
    const neynarConfig = new Configuration({ apiKey: config.FARCASTER_API_KEY || "" });
    const hubConfig = new Configuration({
      apiKey: config.FARCASTER_API_KEY || "",
      basePath: config.FARCASTER_HUB_API_BASE_URL,
    });
    this.neynar = new NeynarAPIClient(neynarConfig);
    this.hub = new NeynarHubClient(hubConfig);
    this.signerUuid = config.FARCASTER_SIGNER_UUID;
  }

  private isPaidEndpointEnabled(kind: "castSearch" | "castConversation"): boolean {
    if (this.config.FARCASTER_ENABLE_PAID_ENDPOINTS) return true;
    if (kind === "castSearch") return this.config.FARCASTER_ENABLE_PAID_CAST_SEARCH;
    if (kind === "castConversation") return this.config.FARCASTER_ENABLE_PAID_CAST_CONVERSATION;
    return false;
  }

  async createCast(text: string, options?: { embeds?: string[] }): Promise<FarcasterCast> {
    const res = await withRetry(() =>
      this.neynar.publishCast({
        signerUuid: this.signerUuid,
        text,
        embeds: options?.embeds,
      })
    );
    if (!(res as any).success) {
      throw new Error("Neynar publishCast returned unsuccessful response");
    }
    return mapCast((res as any).cast);
  }

  async replyToCast(parentId: string, text: string): Promise<FarcasterCast> {
    const res = await withRetry(() =>
      this.neynar.publishCast({
        signerUuid: this.signerUuid,
        text,
        parent: parentId,
      })
    );
    if (!(res as any).success) {
      throw new Error("Neynar publishCast(reply) returned unsuccessful response");
    }
    return mapCast((res as any).cast);
  }

  async getMentions(fid: number, cursor?: string): Promise<{ items: FarcasterCast[]; nextCursor?: string }> {
    try {
      const res = await withRetry(() =>
        this.neynar.fetchAllNotifications({
          fid,
          type: ["mentions", "replies"],
          cursor,
        })
      );

      const notifications = ((res as any).notifications || []) as any[];
      const items = notifications
        .filter((n) => !!n.cast)
        .map((n) => mapCast(n.cast));

      return { items, nextCursor: (res as any).next?.cursor };
    } catch (error: any) {
      const status = error?.status || error?.response?.status;
      if (status === 402 && this.config.FARCASTER_ENABLE_HUB_FALLBACK) {
        const hubRes = await withRetry(() =>
          this.hub.fetchCastsMentioningUser({
            fid,
            pageSize: 25,
            reverse: true,
            pageToken: cursor,
          })
        );
        const items = (((hubRes as any)?.messages || []) as any[]).map(mapHubCast);
        return {
          items,
          nextCursor: (hubRes as any)?.nextPageToken || undefined,
        };
      }
      throw error;
    }
  }

  async getReplies(castId: string, cursor?: string): Promise<{ items: FarcasterCast[]; nextCursor?: string }> {
    if (this.isPaidEndpointEnabled("castConversation")) {
      try {
        const res = await withRetry(() =>
          this.neynar.lookupCastConversation({
            identifier: castId,
            type: "hash",
            limit: 50,
            cursor,
            replyDepth: 2,
          })
        );
        const directReplies = (((res as any).conversation?.direct_replies || []) as any[]).map(mapCast);
        return { items: directReplies, nextCursor: (res as any).next?.cursor };
      } catch (error: any) {
        const status = error?.status || error?.response?.status;
        if (!(status === 402 && this.config.FARCASTER_ENABLE_HUB_FALLBACK)) {
          throw error;
        }
      }
    }

    if (!this.config.FARCASTER_ENABLE_HUB_FALLBACK) {
      return { items: [], nextCursor: undefined };
    }

    const hubRes = await withRetry(() =>
      this.hub.fetchCastsByParent({
        fid: this.config.FARCASTER_FID,
        hash: castId,
        pageSize: 25,
        reverse: true,
        pageToken: cursor,
      })
    );
    const items = (((hubRes as any)?.messages || []) as any[]).map(mapHubCast);
    return { items, nextCursor: (hubRes as any)?.nextPageToken || undefined };
  }

  async getMyRecentCasts(fid: number, cursor?: string): Promise<{ items: FarcasterCast[]; nextCursor?: string }> {
    try {
      const res = await withRetry(() =>
        this.neynar.fetchCastsForUser({
          fid,
          cursor,
          limit: 25,
        })
      );

      return {
        items: (((res as any).casts || []) as any[]).map(mapCast),
        nextCursor: (res as any).next?.cursor,
      };
    } catch (error: any) {
      const status = error?.status || error?.response?.status;
      if (!(status === 402 && this.config.FARCASTER_ENABLE_HUB_FALLBACK)) {
        throw error;
      }

      const hubRes = await withRetry(() =>
        this.hub.fetchUsersCasts({
          fid,
          pageSize: 25,
          reverse: true,
          pageToken: cursor,
        })
      );
      return {
        items: (((hubRes as any)?.messages || []) as any[]).map(mapHubCast),
        nextCursor: (hubRes as any)?.nextPageToken || undefined,
      };
    }
  }

  async getCast(identifier: string): Promise<FarcasterCast | null> {
    try {
      const res = await withRetry(() =>
        this.neynar.lookupCastByHashOrWarpcastUrl({
          identifier,
          type: "hash",
        })
      );
      return mapCast((res as any).cast);
    } catch {
      return null;
    }
  }

  async lookupUserFidByUsername(username: string): Promise<number | null> {
    try {
      const res = await withRetry(() =>
        this.neynar.lookupUserByUsername({
          username: username.replace(/^@/, ""),
        })
      );
      return (res as any)?.user?.fid ?? null;
    } catch {
      return null;
    }
  }

  async searchCasts(q: string, limit = 10): Promise<FarcasterCast[]> {
    if (!this.isPaidEndpointEnabled("castSearch")) {
      return [];
    }

    const res = await withRetry(() =>
      this.neynar.searchCasts({
        q,
        limit,
      })
    );
    const casts =
      ((res as any)?.result?.casts as any[]) ||
      ((res as any)?.casts as any[]) ||
      [];
    return casts.map(mapCast);
  }

  async getMe(fid: number): Promise<FarcasterProfile> {
    const res = await withRetry(() => this.neynar.fetchBulkUsers({ fids: [fid] }));
    const u = (res as any).users?.[0];
    if (!u) throw new Error(`Unable to load profile for fid=${fid}`);
    return { fid, username: u.username, displayName: u.display_name };
  }
}

export class ClientBase {
  runtime: IAgentRuntime;
  farcasterConfig: FarcasterConfig;
  api: FarcasterApiClient;
  profile: FarcasterProfile | null = null;

  constructor(runtime: IAgentRuntime, farcasterConfig: FarcasterConfig) {
    this.runtime = runtime;
    this.farcasterConfig = farcasterConfig;
    this.api = new FarcasterApiClient(farcasterConfig);
  }

  private normalizeOutgoingCastText(text: string): string {
    const platformMax = this.farcasterConfig.FARCASTER_PROTOCOL_PRO ? 1024 : 300;
    if (text.length <= platformMax) return text;
    const safe = text.slice(0, platformMax).trim();
    elizaLogger.warn(
      `[Farcaster] outgoing cast exceeded ${platformMax} chars, clamped to avoid protocol rejection`
    );
    return safe;
  }

  async init(): Promise<void> {
    try {
      this.profile = await this.api.getMe(this.farcasterConfig.FARCASTER_FID);
      elizaLogger.info(
        `[Farcaster] authenticated as @${this.profile.username} (${this.profile.fid}) apiKey=${sanitizeForLog(
          this.farcasterConfig.FARCASTER_API_KEY || ""
        )}`
      );
    } catch (error: any) {
      if (isApiErrorResponse(error)) {
        elizaLogger.error("[Farcaster] invalid credentials or access denied", error.response?.data);
      }
      throw error;
    }
  }

  async postStatus(text: string, options?: { embeds?: string[] }): Promise<FarcasterCast> {
    const safeText = this.normalizeOutgoingCastText(text);
    if (this.farcasterConfig.FARCASTER_DRY_RUN) {
      elizaLogger.info(`[Farcaster][DRY_RUN] post: ${safeText}`);
      return {
        hash: "dry_run_hash",
        text: safeText,
        authorFid: this.farcasterConfig.FARCASTER_FID,
        authorUsername: this.profile?.username,
        authorDisplayName: this.profile?.displayName,
        timestamp: new Date().toISOString(),
      };
    }
    return this.api.createCast(safeText, options);
  }

  async replyTo(parentHash: string, text: string): Promise<FarcasterCast> {
    const safeText = this.normalizeOutgoingCastText(text);
    if (this.farcasterConfig.FARCASTER_DRY_RUN) {
      elizaLogger.info(`[Farcaster][DRY_RUN] reply(${parentHash}): ${safeText}`);
      return {
        hash: "dry_run_reply_hash",
        text: safeText,
        authorFid: this.farcasterConfig.FARCASTER_FID,
        authorUsername: this.profile?.username,
        authorDisplayName: this.profile?.displayName,
        timestamp: new Date().toISOString(),
        parentHash,
      };
    }
    return this.api.replyToCast(parentHash, safeText);
  }
}
