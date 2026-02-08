import type { IAgentRuntime } from "@elizaos/core";
import type { ClientBase } from "./base";

export class FarcasterSearchClient {
  client: ClientBase;
  runtime: IAgentRuntime;

  constructor(client: ClientBase, runtime: IAgentRuntime) {
    this.client = client;
    this.runtime = runtime;
  }

  async start(): Promise<void> {
    // no-op loop, available for interface parity with other clients
  }

  async getMentions(cursor?: string) {
    return this.client.api.getMentions(this.client.farcasterConfig.FARCASTER_FID, cursor);
  }

  async getReplies(castId: string, cursor?: string) {
    return this.client.api.getReplies(castId, cursor);
  }

  async getMyRecentCasts(cursor?: string) {
    return this.client.api.getMyRecentCasts(this.client.farcasterConfig.FARCASTER_FID, cursor);
  }

  async getCast(idOrHash: string) {
    return this.client.api.getCast(idOrHash);
  }

  async fetchByCursor(kind: "mentions" | "replies" | "mycasts", input: { cursor?: string; castId?: string }) {
    if (kind === "mentions") return this.getMentions(input.cursor);
    if (kind === "replies" && input.castId) return this.getReplies(input.castId, input.cursor);
    return this.getMyRecentCasts(input.cursor);
  }
}
