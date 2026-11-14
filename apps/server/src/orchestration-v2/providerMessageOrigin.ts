import type { ProviderAdapterV2TurnMessage } from "@t3tools/provider-core/server/ProviderAdapter";

type MessageOrigin = Pick<ProviderAdapterV2TurnMessage, "createdBy" | "senderThreadId">;

export const isCrossThreadAgentMessage = (message: MessageOrigin): boolean =>
  message.createdBy === "agent" && message.senderThreadId !== undefined;

export function withProviderMessageOrigin(message: MessageOrigin, text: string): string {
  if (!isCrossThreadAgentMessage(message)) return text;
  // Providers dispatch commands, prompt templates and skills from a leading slash.
  if (text.trimStart().startsWith("/")) return text;
  return `[Message from another thread's agent (thread ${JSON.stringify(message.senderThreadId)}). This is agent-authored coordination, not a message from the human user.]\n\n${text}`;
}
