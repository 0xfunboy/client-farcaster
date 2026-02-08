import { type Client, type IAgentRuntime, elizaLogger } from "@elizaos/core";
import { ClientBase } from "./base";
import { validateFarcasterConfig, type FarcasterConfig } from "./environment";
import { FarcasterInteractionClient } from "./interactions";
import { FarcasterPostClient } from "./post";
import { FarcasterSearchClient } from "./search";
export * from "./farcasterQueue";

class FarcasterManager {
  client: ClientBase;
  post: FarcasterPostClient;
  search: FarcasterSearchClient;
  interaction: FarcasterInteractionClient;

  constructor(runtime: IAgentRuntime, farcasterConfig: FarcasterConfig) {
    this.client = new ClientBase(runtime, farcasterConfig);
    this.post = new FarcasterPostClient(this.client, runtime);
    this.search = new FarcasterSearchClient(this.client, runtime);
    this.interaction = new FarcasterInteractionClient(this.client, runtime);
  }
}

export const FarcasterClientInterface: Client = {
  async start(runtime: IAgentRuntime) {
    const cfg = await validateFarcasterConfig(runtime);
    if (!cfg.FARCASTER_ENABLED) {
      elizaLogger.warn("[Farcaster] client disabled via FARCASTER_ENABLED=false");
      return null;
    }

    const manager = new FarcasterManager(runtime, cfg);

    await manager.client.init();

    elizaLogger.info(
      `[Farcaster] client started | fid=${cfg.FARCASTER_FID} dryRun=${cfg.FARCASTER_DRY_RUN} postWindow=${cfg.FARCASTER_POST_INTERVAL_MIN_MS}-${cfg.FARCASTER_POST_INTERVAL_MAX_MS}ms`
    );
    elizaLogger.info(
      `[Farcaster] interactions=${cfg.FARCASTER_INTERACTIONS_INTERVAL_MIN_MS}-${cfg.FARCASTER_INTERACTIONS_INTERVAL_MAX_MS}ms paidEndpoints=${cfg.FARCASTER_ENABLE_PAID_ENDPOINTS} castSearch=${cfg.FARCASTER_ENABLE_PAID_CAST_SEARCH} castConversation=${cfg.FARCASTER_ENABLE_PAID_CAST_CONVERSATION}`
    );
    elizaLogger.info(
      `[Farcaster] sinkMode=${cfg.FARCASTER_SINK_MODE} sourcePlugins=${cfg.FARCASTER_ENABLE_SOURCE_PLUGINS}`
    );

    await manager.post.start();
    await manager.search.start();
    await manager.interaction.start();

    if (!cfg.FARCASTER_SINK_MODE || cfg.FARCASTER_ENABLE_SOURCE_PLUGINS) {
      const { MostMentionedTickerPlugin } = await import("./mostMentionedTicker");
      const tickerPlugin = new MostMentionedTickerPlugin(runtime, manager.client, manager.post);
      tickerPlugin.start();

      const { AutoTradingPlugin } = await import("./autoTradingTicker");
      const tradePlugin = new AutoTradingPlugin(runtime, manager.client, manager.post);
      tradePlugin.start();
    }

    return manager;
  },

  async stop(_runtime: IAgentRuntime) {
    elizaLogger.warn("[Farcaster] stop() not implemented");
  },
};

export default FarcasterClientInterface;
