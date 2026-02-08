# @elizaos/client-farcaster

Client Farcaster per ElizaOS con adapter Neynar, coda persistente, priorita `news > trade`,
modalita sink condivisa con Twitter/Moltbook, e loop interazioni con fallback free-plan.

## Cosa fa

- Pubblica cast su Farcaster (`createCast`, `replyToCast`).
- Consuma post da coda condivisa (`farcaster:queue:<agentId>`) per evitare generazioni LLM duplicate.
- Mantiene stato locale JSON (queue, rate, processed interactions) in `src/plugins/**`.
- Gestisce rate limit:
  - limiti hour/day applicativi.
  - pacing richieste `cast` (free plan).
  - backoff automatico su `429` con `Retry-After`.
- Gestisce split in thread per cast lunghi con limiti protocollo:
  - non-Pro: clamp/split a 300 caratteri.
  - Pro: fino a 1024 (configurabile).
- Supporta embed immagine da approval Discord (URL `media.discordapp.net`) sul primo cast del thread.

## Architettura rapida

- `src/base.ts`
  - adapter API Neynar + fallback Hub.
  - publish/reply con retry/backoff.
- `src/post.ts`
  - coda persistente, import shared-queue, priorita `news > trade`, scheduler post.
- `src/interactions.ts`
  - mentions/replies polling, filtri anti-loop, risposta LLM in thread.
- `src/farcasterQueue.ts`
  - schema queue cross-client (news/trade/other + embedUrl).
- `src/environment.ts`
  - parsing env + defaults + validazione.

## Modalita operative

### 1) Sink mode (consigliata)

`FARCASTER_SINK_MODE=true`

Farcaster non genera post da solo: consuma output upstream (es. Twitter approval/news pipeline).
Questo mantiene una singola origine contenuti multi-client.

### 2) Source plugins (opzionale)

`FARCASTER_ENABLE_SOURCE_PLUGINS=true`

Abilita plugin locali `mostMentionedTicker` / `autoTradingTicker` anche su Farcaster.
Tipicamente da lasciare `false` in setup shared-origin.

## Setup

1. Installa dipendenze dal workspace Eliza.
2. Configura env (vedi `.env.example`).
3. Nel character JSON aggiungi:
   - `"clients": ["farcaster"]`
4. Avvia l'agent:
   - `pnpm start dev --character="characters/<your.character>.json"`

## Variabili env

### Obbligatorie

- `FARCASTER_ENABLED`
- `FARCASTER_API_KEY` (oppure `FARCASTER_NEYNAR_API_KEY`)
- `FARCASTER_SIGNER_UUID` (oppure `FARCASTER_NEYNAR_SIGNER_UUID`)
- `FARCASTER_FID`

### Core

- `FARCASTER_DRY_RUN`
- `FARCASTER_SINK_MODE`
- `FARCASTER_ENABLE_SOURCE_PLUGINS`
- `FARCASTER_ENABLE_AUTONOMOUS_POST_GENERATION`
- `FARCASTER_PROTOCOL_PRO`

### Endpoint e plan

- `FARCASTER_ENABLE_PAID_ENDPOINTS`
- `FARCASTER_ENABLE_PAID_CAST_SEARCH`
- `FARCASTER_ENABLE_PAID_CAST_CONVERSATION`
- `FARCASTER_ENABLE_HUB_FALLBACK`

### Posting / rate

- `FARCASTER_MAX_POSTS_PER_HOUR`
- `FARCASTER_MAX_POSTS_PER_DAY`
- `FARCASTER_CAST_REQUEST_MIN_INTERVAL_MS`
- `FARCASTER_MAX_CAST_LENGTH`
- `FARCASTER_QUEUE_MAX_SIZE`
- `FARCASTER_NEWS_PRIORITY_WEIGHT`
- `FARCASTER_TRADE_PRIORITY_WEIGHT`

### Interazioni

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

### Targeting opzionale

- `FARCASTER_TARGET_USERS`
- `FARCASTER_TARGET_FIDS`
- `FARCASTER_TARGET_TOPICS`

## Free plan Neynar: impostazioni consigliate

- `FARCASTER_ENABLE_PAID_ENDPOINTS=false`
- `FARCASTER_ENABLE_PAID_CAST_SEARCH=false`
- `FARCASTER_ENABLE_PAID_CAST_CONVERSATION=false`
- `FARCASTER_CAST_REQUEST_MIN_INTERVAL_MS=10500`
- `FARCASTER_REPLY_FETCH_CASTS_PER_TICK=1`
- `FARCASTER_REPLIES_MIN_INTERVAL_MS=10000`
- `FARCASTER_PROTOCOL_PRO=false`
- `FARCASTER_MAX_CAST_LENGTH=300`

## Persistenza stati

File principali:

- `src/plugins/postNewsJSON/postQueueState.json`
- `src/plugins/postNewsJSON/rateLimitState.json`
- `src/plugins/postNewsJSON/interactionState.json`
- `src/plugins/postNewsJSON/postedNewsState.json`

## Build

- `pnpm -C packages/client-farcaster build`

Output in `dist/`.

## Troubleshooting

- `400 Requires Farcaster protocol Pro subscription`
  - cast troppo lungo senza Pro.
  - lascia `FARCASTER_PROTOCOL_PRO=false` e `FARCASTER_MAX_CAST_LENGTH=300`.
- `429 Rate limit exceeded /v2/farcaster/cast`
  - aumenta `FARCASTER_CAST_REQUEST_MIN_INTERVAL_MS` (es. 12000-15000).
- `402 Payment Required` su search/conversation
  - endpoint paid: lascia `FARCASTER_ENABLE_PAID_* = false`.
- queue bloccata ma senza errori
  - controlla warning quota hour/day e attesa finestra successiva.

## Note sicurezza

- Non loggare mai API keys complete.
- Evita commit di `.env` con credenziali reali.
