import type { IAgentRuntime } from "@elizaos/core";

export type FarcasterQueueKind = "news" | "trade" | "other";

export type FarcasterQueueItem = {
  id: string;
  content: string;
  kind: FarcasterQueueKind;
  priority: boolean;
  createdAt: number;
  parentHash?: string;
  embedUrl?: string;
};

export function getFarcasterQueueKey(runtime: IAgentRuntime): string {
  return `farcaster:queue:${runtime.agentId}`;
}

export async function enqueueFarcasterPost(
  runtime: IAgentRuntime,
  input: {
    content: string;
    kind?: FarcasterQueueKind;
    priority?: boolean;
    parentHash?: string;
    embedUrl?: string;
    id?: string;
  }
): Promise<void> {
  const cache = runtime.cacheManager;
  if (!cache) return;

  const queueKey = getFarcasterQueueKey(runtime);
  const queue = (await cache.get<FarcasterQueueItem[]>(queueKey)) || [];

  const item: FarcasterQueueItem = {
    id: input.id || `farcaster-q-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    content: input.content,
    kind: input.kind || "other",
    priority: input.priority ?? false,
    parentHash: input.parentHash,
    embedUrl: input.embedUrl,
    createdAt: Date.now(),
  };

  queue.push(item);
  await cache.set(queueKey, queue);
}
