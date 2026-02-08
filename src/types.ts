import type { UUID } from "@elizaos/core";

export type QueueKind = "news" | "trade";

export type QueueItem = {
  id: string;
  kind: QueueKind;
  text: string;
  createdAt: number;
  parentHash?: string;
  metadata?: Record<string, string | number | boolean>;
};

export type QueueState = {
  version: 1;
  items: QueueItem[];
};

export type RateLimitSnapshot = {
  version: 1;
  postedAt: number[];
};

export type InteractionState = {
  version: 1;
  lastMentionsCursor?: string;
  lastRepliesCursorByHash: Record<string, string | undefined>;
  lastRepliesFetchAt?: number;
  processed: Record<string, number>;
};

export type FarcasterCast = {
  hash: string;
  text: string;
  authorFid: number;
  authorUsername?: string;
  authorDisplayName?: string;
  timestamp: string;
  parentHash?: string;
  parentAuthorFid?: number;
};

export type FarcasterProfile = {
  fid: number;
  username: string;
  displayName?: string;
};

export type OutboundReplyContext = {
  roomId: UUID;
  inReplyToMemoryId?: UUID;
};
