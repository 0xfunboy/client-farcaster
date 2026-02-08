# @elizaos/client-farcaster

Farcaster client for ElizaOS with a Neynar adapter, persistent queue, `news > trade` priority,
shared sink mode with Twitter/Moltbook, and interaction loops with free-plan-safe fallback behavior.

## What it does

- Publishes casts on Farcaster (`createCast`, `replyToCast`).
- Consumes posts from a shared queue (`farcaster:queue:<agentId>`) to avoid duplicate LLM generation.
- Persists local JSON state (queue, rate snapshots, processed interactions) in `src/plugins/**`.
- Handles rate limiting:
  - app-level hourly/daily caps.
  - request pacing for cast publishing (free plan safe).
  - automatic `429` backoff with `Retry-After`.
- Splits long content into thread chunks with protocol-aware limits:
  - non-Pro: clamp/split to 300 chars.
  - Pro: up to 1024 chars (configurable).
- Supports image embeds from Discord approval messages (`media.discordapp.net`) on the first cast in a thread.

## Architecture overview

- `src/base.ts`
  - Neynar API adapter + Hub fallback.
  - publish/reply with retry and backoff.
- `src/post.ts`
  - persistent queue, shared-queue import, `news > trade` prioritization, posting scheduler.
- `src/interactions.ts`
  - mentions/replies polling, anti-loop filters, LLM reply generation in-thread.
- `src/farcasterQueue.ts`
  - cross-client queue schema (`news/trade/other` + `embedUrl`).
- `src/environment.ts`
  - env parsing, defaults, and validation.

## Operating modes

### 1) Sink mode (recommended)

`FARCASTER_SINK_MODE=true`

Farcaster does not generate independent posts; it consumes upstream output
(for example Twitter approval/news pipeline), keeping a single content origin across clients.

### 2) Source plugins (optional)

`FARCASTER_ENABLE_SOURCE_PLUGINS=true`

Enables local `mostMentionedTicker` / `autoTradingTicker` plugins directly in Farcaster.
Usually keep this `false` in shared-origin setups.

## Setup

1. Install dependencies from the Eliza workspace.
2. Configure env vars (see `.env.example`).
3. Add to your character JSON:
   - `"clients": ["farcaster"]`
4. Start the agent:
   - `pnpm start dev --character="characters/<your.character>.json"`

## Environment variables

### Required

- `FARCASTER_ENABLED`
- `FARCASTER_API_KEY` (or `FARCASTER_NEYNAR_API_KEY`)
- `FARCASTER_SIGNER_UUID` (or `FARCASTER_NEYNAR_SIGNER_UUID`)
- `FARCASTER_FID`

### Core

- `FARCASTER_DRY_RUN`
- `FARCASTER_SINK_MODE`
- `FARCASTER_ENABLE_SOURCE_PLUGINS`
- `FARCASTER_ENABLE_AUTONOMOUS_POST_GENERATION`
- `FARCASTER_PROTOCOL_PRO`

### Endpoints and plan flags

- `FARCASTER_ENABLE_PAID_ENDPOINTS`
- `FARCASTER_ENABLE_PAID_CAST_SEARCH`
- `FARCASTER_ENABLE_PAID_CAST_CONVERSATION`
- `FARCASTER_ENABLE_HUB_FALLBACK`

### Posting / rate controls

- `FARCASTER_MAX_POSTS_PER_HOUR`
- `FARCASTER_MAX_POSTS_PER_DAY`
- `FARCASTER_CAST_REQUEST_MIN_INTERVAL_MS`
- `FARCASTER_MAX_CAST_LENGTH`
- `FARCASTER_QUEUE_MAX_SIZE`
- `FARCASTER_NEWS_PRIORITY_WEIGHT`
- `FARCASTER_TRADE_PRIORITY_WEIGHT`

### Interaction controls

- `FARCASTER_ENABLE_ACTION_PROCESSING`
- `FARCASTER_ACTION_INTERVAL`
- `FARCASTER_MAX_ACTIONS_PROCESSING`
- `FARCASTER_INTERACTIONS_INTERVAL_MIN_MS`
- `FARCASTER_INTERACTIONS_INTERVAL_MAX_MS`
- `FARCASTER_REPLIES_MIN_INTERVAL_MS`
- `FARCASTER_REPLY_FETCH_CASTS_PER_TICK`
- `FARCASTER_MAX_INTERACTIONS_PER_HOUR`
- `FARCASTER_IGNORE_BOT_AUTHORS`
- `FARCASTER_PROCESSED_MESSAGE_TTL_MS`

### Optional targeting

- `FARCASTER_TARGET_USERS`
- `FARCASTER_TARGET_FIDS`
- `FARCASTER_TARGET_TOPICS`

## Recommended settings for Neynar free plan

- `FARCASTER_ENABLE_PAID_ENDPOINTS=false`
- `FARCASTER_ENABLE_PAID_CAST_SEARCH=false`
- `FARCASTER_ENABLE_PAID_CAST_CONVERSATION=false`
- `FARCASTER_CAST_REQUEST_MIN_INTERVAL_MS=10500`
- `FARCASTER_REPLY_FETCH_CASTS_PER_TICK=1`
- `FARCASTER_REPLIES_MIN_INTERVAL_MS=10000`
- `FARCASTER_PROTOCOL_PRO=false`
- `FARCASTER_MAX_CAST_LENGTH=300`

## Persistent state files

- `src/plugins/postNewsJSON/postQueueState.json`
- `src/plugins/postNewsJSON/rateLimitState.json`
- `src/plugins/postNewsJSON/interactionState.json`
- `src/plugins/postNewsJSON/postedNewsState.json`

## Build

- `pnpm -C packages/client-farcaster build`

Build output is generated in `dist/`.

## Troubleshooting

- `400 Requires Farcaster protocol Pro subscription`
  - cast is too long for non-Pro.
  - keep `FARCASTER_PROTOCOL_PRO=false` and `FARCASTER_MAX_CAST_LENGTH=300`.
- `429 Rate limit exceeded /v2/farcaster/cast`
  - increase `FARCASTER_CAST_REQUEST_MIN_INTERVAL_MS` (for example `12000-15000`).
- `402 Payment Required` on search/conversation
  - paid endpoints are disabled on free plans; keep `FARCASTER_ENABLE_PAID_* = false`.
- queue appears stuck with no hard errors
  - check hourly/daily quota warnings and wait for the next window.

## Security notes

- Never log full API keys.
- Never commit real secrets in `.env`.
