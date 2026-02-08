import fs from "fs";
import path from "path";
import crypto from "crypto";
import { elizaLogger, type IAgentRuntime } from "@elizaos/core";
import type { ClientBase } from "./base";
import type { FarcasterPostClient } from "./post";
import { resolvePackagePath, resolveWorkspacePath } from "./utils";

type RankingItem = {
  symbol?: string;
  ticker?: string;
  position?: number;
  rank?: number;
  mentions?: number;
};

type MentionState = {
  lastPostedTicker?: string;
  lastPostedAt?: number;
  lastRankingDigest?: string;
};

export class MostMentionedTickerPlugin {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private runtime: IAgentRuntime,
    private _client: ClientBase,
    private postClient: FarcasterPostClient
  ) {}

  private stateFile(): string {
    return resolvePackagePath(
      "src",
      "plugins",
      "mostMentionedTickerJSON",
      "postedMentionedState.json"
    );
  }

  private loadState(): MentionState {
    try {
      const raw = fs.readFileSync(this.stateFile(), "utf8");
      return JSON.parse(raw) as MentionState;
    } catch {
      return {};
    }
  }

  private saveState(state: MentionState): void {
    const f = this.stateFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(state, null, 2), "utf8");
  }

  private loadRanking(): RankingItem[] {
    const localFile = resolvePackagePath(
      "src",
      "plugins",
      "mostMentionedTickerJSON",
      "tickerRankingComparison.json"
    );
    const twitterFile = resolveWorkspacePath(
      "packages",
      "client-twitter",
      "src",
      "plugins",
      "mostMentionedTickerJSON",
      "tickerRankingComparison.json"
    );
    const file = fs.existsSync(twitterFile) ? twitterFile : localFile;
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private pickMessage(): { text: string; symbol?: string; rankingDigest: string } | null {
    const rankings = this.loadRanking();
    const top = rankings[0];
    if (!top) return null;
    const rankingDigest = crypto.createHash("sha256").update(JSON.stringify(rankings.slice(0, 10))).digest("hex");
    const pos = Number(top.position ?? top.rank ?? 0);
    const symbol = (top.symbol || top.ticker || "UNKNOWN").toString().toUpperCase();
    const text = `Most-mentioned ticker sync: $${symbol} is currently leading${Number.isFinite(pos) ? ` at rank #${pos + 1}` : ""}. I am watching mention acceleration versus real liquidity before chasing entries.`;
    return { text, symbol, rankingDigest };
  }

  start(): void {
    const loop = async () => {
      try {
        const signal = this.pickMessage();
        if (signal) {
          const state = this.loadState();
          if (state.lastRankingDigest === signal.rankingDigest) {
            return;
          }
          await this.postClient.generateNewTweetForMostMentionedTicker(signal.text);
          this.saveState({
            lastPostedTicker: signal.symbol,
            lastPostedAt: Date.now(),
            lastRankingDigest: signal.rankingDigest,
          });
          elizaLogger.info("[Farcaster] MostMentionedTickerPlugin queued trade cast");
        }
      } catch (error) {
        elizaLogger.warn("[Farcaster] MostMentionedTickerPlugin error", error);
      } finally {
        const minMs = Math.max(60_000, Number(this.runtime.getSetting("FARCASTER_POST_INTERVAL_MIN_MS") || 30 * 60 * 1000));
        this.timer = setTimeout(loop, minMs);
      }
    };

    void loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
