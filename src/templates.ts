import { messageCompletionFooter, shouldRespondFooter } from "@elizaos/core";

export const farcasterMessageHandlerTemplate = `
# About {{agentName}} (@{{farcasterUsername}})
{{bio}}
{{lore}}
{{topics}}

{{providers}}

Recent interactions:
{{recentPostInteractions}}

Current post:
{{currentPost}}

Conversation thread:
{{formattedConversation}}

# Task
Write a concise reply in the voice of {{agentName}}. Be helpful, avoid spam and repetition.
` + messageCompletionFooter;

export const farcasterShouldRespondTemplate = `
# Task
Decide if {{agentName}} should respond to the current Farcaster message.

Return exactly one tag: [RESPOND], [IGNORE], or [STOP].

Rules:
- RESPOND if directly addressed or strongly relevant to the agent scope.
- IGNORE if generic, off-topic, or low-signal.
- STOP if user asks to stop.
- Prefer IGNORE over over-engaging.

Current post:
{{currentPost}}

Conversation thread:
{{formattedConversation}}
` + shouldRespondFooter;
