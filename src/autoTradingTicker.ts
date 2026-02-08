import fs from "fs";
import path from "path";
import crypto from "crypto";
import { elizaLogger, type IAgentRuntime } from "@elizaos/core";
import type { ClientBase } from "./base";
import type { FarcasterPostClient } from "./post";
import { resolvePackagePath, resolveWorkspacePath } from "./utils";

type TradeState = {
  lastReset: number;
  posted: string[];
  lastSourceDigest?: string;
};

const DEFAULT_STATE: TradeState = {
  lastReset: 0,
  posted: [],
};

export class AutoTradingPlugin {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private runtime: IAgentRuntime,
    private _client: ClientBase,
    private postClient: FarcasterPostClient
  ) {}

  private stateFile(): string {
    return resolvePackagePath("src", "plugins", "autoTradingTickerJSON", "postedTradeState.json");
  }

  private loadState(): TradeState {
    const f = this.stateFile();
    if (!fs.existsSync(f)) return { ...DEFAULT_STATE };
    try {
      const x = JSON.parse(fs.readFileSync(f, "utf8"));
      return {
        lastReset: Number(x.lastReset || 0),
        posted: Array.isArray(x.posted) ? x.posted : [],
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  private saveState(state: TradeState): void {
    const f = this.stateFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(state, null, 2), "utf8");
  }

  private buildTradeSignal(): { text: string; digest: string } | null {
    const twitterStateFile = resolveWorkspacePath(
      "packages",
      "client-twitter",
      "src",
      "plugins",
      "autoTradingTickerJSON",
      "tweetedTickersState.json"
    );
    const mostMentionedStateFile = resolveWorkspacePath(
      "packages",
      "client-twitter",
      "src",
      "plugins",
      "mostMentionedTickerJSON",
      "tweetedTickersState.json"
    );

    const readTickers = (file: string): string[] => {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return Array.isArray(parsed?.tweeted) ? parsed.tweeted : [];
      } catch {
        return [];
      }
    };

    const autoTradingTickers = readTickers(twitterStateFile);
    const mostMentionedTickers = readTickers(mostMentionedStateFile);

    const candidates = [
      ...autoTradingTickers,
      ...mostMentionedTickers,
    ].map((x) => String(x).toUpperCase());

    if (!candidates.length) {
      return null;
    }

    const chosen = candidates[candidates.length - 1] || "SOL";
    const sourceSnapshot = {
      autoTradingTickers,
      mostMentionedTickers,
    };
    const digest = crypto.createHash("sha256").update(JSON.stringify(sourceSnapshot)).digest("hex");
    const text = `Cross-client trade sync: $${chosen} just triggered from the trading pipeline. I am tracking momentum, liquidity shift, and execution risk before confirming continuation.`;
    return { text, digest };
  }

  start(): void {
    const loop = async () => {
      try {
        const state = this.loadState();
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        if (!state.lastReset || state.lastReset < dayAgo) {
          state.lastReset = Date.now();
          state.posted = [];
        }

        const signal = this.buildTradeSignal();
        if (!signal) {
          return;
        }

        if (state.lastSourceDigest !== signal.digest && !state.posted.includes(signal.text)) {
          await this.postClient.generateNewTweetForAutotradingTicker(signal.text);
          state.posted.push(signal.text);
          state.lastSourceDigest = signal.digest;
          this.saveState(state);
          elizaLogger.info("[Farcaster] AutoTradingPlugin queued trade cast");
        }
      } catch (error) {
        elizaLogger.warn("[Farcaster] AutoTradingPlugin error", error);
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
