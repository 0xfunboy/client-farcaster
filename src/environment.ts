import { parseBooleanFromText, type IAgentRuntime } from "@elizaos/core";
import { z, ZodError } from "zod";

const toBool = (v?: string | null, def = false) => parseBooleanFromText(v) ?? def;
const toInt = (v: string | undefined | null, def: number) => {
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
};
const toList = (v?: string | null) =>
  (v || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export const farcasterEnvSchema = z.object({
  FARCASTER_ENABLED: z.boolean().default(true),
  FARCASTER_DRY_RUN: z.boolean().default(false),
  FARCASTER_SINK_MODE: z.boolean().default(true),
  FARCASTER_ENABLE_SOURCE_PLUGINS: z.boolean().default(false),
  FARCASTER_ENABLE_AUTONOMOUS_POST_GENERATION: z.boolean().default(false),
  FARCASTER_PROTOCOL_PRO: z.boolean().default(false),
  FARCASTER_ENABLE_PAID_ENDPOINTS: z.boolean().default(false),
  FARCASTER_ENABLE_PAID_CAST_SEARCH: z.boolean().default(false),
  FARCASTER_ENABLE_PAID_CAST_CONVERSATION: z.boolean().default(false),

  FARCASTER_API_BASE_URL: z.string().min(1).default("https://api.neynar.com"),
  FARCASTER_HUB_API_BASE_URL: z.string().min(1).default("https://snapchain-api.neynar.com"),
  FARCASTER_API_KEY: z.string().optional(),
  FARCASTER_BEARER_TOKEN: z.string().optional(),
  FARCASTER_ENABLE_HUB_FALLBACK: z.boolean().default(true),

  FARCASTER_SIGNER_UUID: z.string().min(1),
  FARCASTER_FID: z.number().int().min(1),

  FARCASTER_POST_INTERVAL_MIN_MS: z.number().int().min(5_000).default(30 * 60 * 1000),
  FARCASTER_POST_INTERVAL_MAX_MS: z.number().int().min(5_000).default(60 * 60 * 1000),
  FARCASTER_INTERACTIONS_INTERVAL_MIN_MS: z.number().int().min(10_000).default(60 * 1000),
  FARCASTER_INTERACTIONS_INTERVAL_MAX_MS: z.number().int().min(10_000).default(2 * 60 * 1000),
  FARCASTER_REPLIES_MIN_INTERVAL_MS: z.number().int().min(1_000).default(10_000),
  FARCASTER_REPLY_FETCH_CASTS_PER_TICK: z.number().int().min(0).default(1),
  FARCASTER_MAX_CAST_LENGTH: z.number().int().min(120).max(1024).default(300),
  FARCASTER_CAST_REQUEST_MIN_INTERVAL_MS: z.number().int().min(1_000).default(10_500),

  FARCASTER_MAX_POSTS_PER_DAY: z.number().int().min(1).default(120),
  FARCASTER_MAX_POSTS_PER_HOUR: z.number().int().min(1).default(20),
  FARCASTER_MAX_INTERACTIONS_PER_HOUR: z.number().int().min(1).default(30),

  FARCASTER_QUEUE_MAX_SIZE: z.number().int().min(1).default(300),
  FARCASTER_NEWS_PRIORITY_WEIGHT: z.number().int().min(1).default(100),
  FARCASTER_TRADE_PRIORITY_WEIGHT: z.number().int().min(1).default(10),

  FARCASTER_IGNORE_BOT_AUTHORS: z.boolean().default(true),
  FARCASTER_PROCESSED_MESSAGE_TTL_MS: z.number().int().min(60_000).default(24 * 60 * 60 * 1000),
  ENABLE_ACTION_PROCESSING: z.boolean().default(true),
  ACTION_INTERVAL: z.number().int().min(1).default(2),
  MAX_ACTIONS_PROCESSING: z.number().int().min(1).default(1),

  FARCASTER_TARGET_USERS: z.array(z.string()).default([]),
  FARCASTER_TARGET_FIDS: z.array(z.number().int().min(1)).default([]),
  FARCASTER_TARGET_TOPICS: z.array(z.string()).default([]),

  FARCASTER_FEED_RSS_URL: z.string().url().optional(),
});

export type FarcasterConfig = z.infer<typeof farcasterEnvSchema>;

function getSetting(runtime: IAgentRuntime, key: string): string | undefined {
  return runtime.getSetting(key) || process.env[key];
}

export async function validateFarcasterConfig(runtime: IAgentRuntime): Promise<FarcasterConfig> {
  try {
    const raw = {
      FARCASTER_ENABLED: toBool(getSetting(runtime, "FARCASTER_ENABLED"), true),
      FARCASTER_DRY_RUN: toBool(getSetting(runtime, "FARCASTER_DRY_RUN"), false),
      FARCASTER_SINK_MODE: toBool(getSetting(runtime, "FARCASTER_SINK_MODE"), true),
      FARCASTER_ENABLE_SOURCE_PLUGINS: toBool(
        getSetting(runtime, "FARCASTER_ENABLE_SOURCE_PLUGINS"),
        false
      ),
      FARCASTER_ENABLE_AUTONOMOUS_POST_GENERATION: toBool(
        getSetting(runtime, "FARCASTER_ENABLE_AUTONOMOUS_POST_GENERATION"),
        false
      ),
      FARCASTER_PROTOCOL_PRO: toBool(
        getSetting(runtime, "FARCASTER_PROTOCOL_PRO"),
        false
      ),
      FARCASTER_ENABLE_PAID_ENDPOINTS: toBool(
        getSetting(runtime, "FARCASTER_ENABLE_PAID_ENDPOINTS"),
        false
      ),
      FARCASTER_ENABLE_PAID_CAST_SEARCH: toBool(
        getSetting(runtime, "FARCASTER_ENABLE_PAID_CAST_SEARCH"),
        false
      ),
      FARCASTER_ENABLE_PAID_CAST_CONVERSATION: toBool(
        getSetting(runtime, "FARCASTER_ENABLE_PAID_CAST_CONVERSATION"),
        false
      ),

      FARCASTER_API_BASE_URL: getSetting(runtime, "FARCASTER_API_BASE_URL") || "https://api.neynar.com",
      FARCASTER_HUB_API_BASE_URL: getSetting(runtime, "FARCASTER_HUB_API_BASE_URL") || "https://snapchain-api.neynar.com",
      FARCASTER_API_KEY: getSetting(runtime, "FARCASTER_API_KEY") || getSetting(runtime, "FARCASTER_NEYNAR_API_KEY"),
      FARCASTER_BEARER_TOKEN: getSetting(runtime, "FARCASTER_BEARER_TOKEN"),
      FARCASTER_ENABLE_HUB_FALLBACK: toBool(
        getSetting(runtime, "FARCASTER_ENABLE_HUB_FALLBACK"),
        true
      ),

      FARCASTER_SIGNER_UUID: getSetting(runtime, "FARCASTER_SIGNER_UUID") || getSetting(runtime, "FARCASTER_NEYNAR_SIGNER_UUID"),
      FARCASTER_FID: toInt(getSetting(runtime, "FARCASTER_FID"), 0),

      FARCASTER_POST_INTERVAL_MIN_MS: toInt(getSetting(runtime, "FARCASTER_POST_INTERVAL_MIN_MS"), toInt(getSetting(runtime, "POST_INTERVAL_MIN"), 30) * 60 * 1000),
      FARCASTER_POST_INTERVAL_MAX_MS: toInt(getSetting(runtime, "FARCASTER_POST_INTERVAL_MAX_MS"), toInt(getSetting(runtime, "POST_INTERVAL_MAX"), 60) * 60 * 1000),
      FARCASTER_INTERACTIONS_INTERVAL_MIN_MS: toInt(
        getSetting(runtime, "FARCASTER_INTERACTIONS_INTERVAL_MIN_MS"),
        toInt(getSetting(runtime, "FARCASTER_POLL_INTERVAL"), 120) * 1000
      ),
      FARCASTER_INTERACTIONS_INTERVAL_MAX_MS: toInt(
        getSetting(runtime, "FARCASTER_INTERACTIONS_INTERVAL_MAX_MS"),
        Math.max(
          toInt(getSetting(runtime, "FARCASTER_INTERACTIONS_INTERVAL_MIN_MS"), toInt(getSetting(runtime, "FARCASTER_POLL_INTERVAL"), 120) * 1000),
          toInt(getSetting(runtime, "ACTION_INTERVAL"), 2) * 60 * 1000
        )
      ),
      FARCASTER_REPLIES_MIN_INTERVAL_MS: toInt(
        getSetting(runtime, "FARCASTER_REPLIES_MIN_INTERVAL_MS"),
        10_000
      ),
      FARCASTER_REPLY_FETCH_CASTS_PER_TICK: toInt(
        getSetting(runtime, "FARCASTER_REPLY_FETCH_CASTS_PER_TICK"),
        1
      ),
      FARCASTER_MAX_CAST_LENGTH: toInt(
        getSetting(runtime, "FARCASTER_MAX_CAST_LENGTH"),
        300
      ),
      FARCASTER_CAST_REQUEST_MIN_INTERVAL_MS: toInt(
        getSetting(runtime, "FARCASTER_CAST_REQUEST_MIN_INTERVAL_MS"),
        10_500
      ),

      FARCASTER_MAX_POSTS_PER_DAY: toInt(getSetting(runtime, "FARCASTER_MAX_POSTS_PER_DAY"), 120),
      FARCASTER_MAX_POSTS_PER_HOUR: toInt(getSetting(runtime, "FARCASTER_MAX_POSTS_PER_HOUR"), 20),
      FARCASTER_MAX_INTERACTIONS_PER_HOUR: toInt(getSetting(runtime, "FARCASTER_MAX_INTERACTIONS_PER_HOUR"), 30),

      FARCASTER_QUEUE_MAX_SIZE: toInt(getSetting(runtime, "FARCASTER_QUEUE_MAX_SIZE"), 300),
      FARCASTER_NEWS_PRIORITY_WEIGHT: toInt(getSetting(runtime, "FARCASTER_NEWS_PRIORITY_WEIGHT"), 100),
      FARCASTER_TRADE_PRIORITY_WEIGHT: toInt(getSetting(runtime, "FARCASTER_TRADE_PRIORITY_WEIGHT"), 10),

      FARCASTER_IGNORE_BOT_AUTHORS: toBool(getSetting(runtime, "FARCASTER_IGNORE_BOT_AUTHORS"), true),
      FARCASTER_PROCESSED_MESSAGE_TTL_MS: toInt(getSetting(runtime, "FARCASTER_PROCESSED_MESSAGE_TTL_MS"), 24 * 60 * 60 * 1000),
      ENABLE_ACTION_PROCESSING: toBool(
        getSetting(runtime, "FARCASTER_ENABLE_ACTION_PROCESSING") ?? getSetting(runtime, "ENABLE_ACTION_PROCESSING"),
        true
      ),
      ACTION_INTERVAL: toInt(
        getSetting(runtime, "FARCASTER_ACTION_INTERVAL") ?? getSetting(runtime, "ACTION_INTERVAL"),
        2
      ),
      MAX_ACTIONS_PROCESSING: toInt(
        getSetting(runtime, "FARCASTER_MAX_ACTIONS_PROCESSING") ?? getSetting(runtime, "MAX_ACTIONS_PROCESSING"),
        1
      ),
      FARCASTER_TARGET_USERS: toList(getSetting(runtime, "FARCASTER_TARGET_USERS")),
      FARCASTER_TARGET_FIDS: toList(getSetting(runtime, "FARCASTER_TARGET_FIDS")).map((x) => Number.parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0),
      FARCASTER_TARGET_TOPICS: toList(getSetting(runtime, "FARCASTER_TARGET_TOPICS")),

      FARCASTER_FEED_RSS_URL: getSetting(runtime, "FARCASTER_FEED_RSS_URL"),
    };

    const parsed = farcasterEnvSchema.parse(raw);

    if (!parsed.FARCASTER_API_KEY && !parsed.FARCASTER_BEARER_TOKEN) {
      throw new Error("Missing FARCASTER_API_KEY (or FARCASTER_NEYNAR_API_KEY) / FARCASTER_BEARER_TOKEN");
    }

    if (parsed.FARCASTER_POST_INTERVAL_MIN_MS > parsed.FARCASTER_POST_INTERVAL_MAX_MS) {
      throw new Error("FARCASTER_POST_INTERVAL_MIN_MS cannot be greater than FARCASTER_POST_INTERVAL_MAX_MS");
    }

    if (parsed.FARCASTER_INTERACTIONS_INTERVAL_MIN_MS > parsed.FARCASTER_INTERACTIONS_INTERVAL_MAX_MS) {
      throw new Error("FARCASTER_INTERACTIONS_INTERVAL_MIN_MS cannot be greater than FARCASTER_INTERACTIONS_INTERVAL_MAX_MS");
    }

    return parsed;
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("\n");
      throw new Error(`Farcaster configuration validation failed:\n${details}`);
    }
    throw error;
  }
}
