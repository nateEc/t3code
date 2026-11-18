import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import {
  EnvironmentContextRecord,
  type OrchestrationMessageContext,
  ThreadContextRecord,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  recallComposerText,
  stripLegacyPromptDecoration,
} from "@t3tools/shared/composerContextReferences";
import { Schema } from "effect";

/** Sends record provenance; messages sent without it keep the legacy heuristic. */
export function recallableComposerPrompt(
  messageText: string,
  context?: OrchestrationMessageContext,
  keptContextIds?: ReadonlySet<string>,
): string {
  return context?.composerRecall === undefined
    ? stripLegacyPromptDecoration(messageText, keptContextIds)
    : recallComposerText(messageText, context);
}

const isThreadContextRecord = Schema.is(ThreadContextRecord);
const isEnvironmentContextRecord = Schema.is(EnvironmentContextRecord);

type ComposerPromptHistoryMessage = Parameters<typeof resolveUserMessagePresentation>[0] & {
  readonly id: string;
  readonly context?: OrchestrationMessageContext | undefined;
};

/** Thread and machine mentions; the draft holds these records, so recall can restore their chips. */
export interface ComposerPromptHistoryMentions {
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly environmentContexts: ReadonlyArray<EnvironmentContextRecord>;
}

const NO_MENTIONS: ComposerPromptHistoryMentions = { threadContexts: [], environmentContexts: [] };

interface ComposerPromptHistoryEntry {
  readonly id: string;
  readonly prompt: string;
  readonly mentions: ComposerPromptHistoryMentions;
}

export interface ComposerPromptHistoryPosition {
  readonly entryId: string;
  readonly recalled: string;
}

function findActive(
  entries: ReadonlyArray<ComposerPromptHistoryEntry>,
  position: ComposerPromptHistoryPosition,
): number {
  const byId = entries.findIndex((entry) => entry.id === position.entryId);
  if (byId >= 0) return byId;
  return entries.findLastIndex((entry) => entry.prompt === position.recalled);
}

interface ComposerPromptHistoryStep {
  readonly position: ComposerPromptHistoryPosition | null;
  readonly prompt: string;
  readonly mentions: ComposerPromptHistoryMentions;
}

/** A sent message's text as the composer can hold it, with the mention records its chips need. */
function recallComposerMessage(
  message: Pick<ComposerPromptHistoryMessage, "text" | "context">,
): Pick<ComposerPromptHistoryEntry, "prompt" | "mentions"> {
  const records = message.context?.records ?? [];
  const threadRecords = records.filter(isThreadContextRecord);
  const environmentRecords = records.filter(isEnvironmentContextRecord);
  const prompt = recallableComposerPrompt(
    message.text,
    message.context,
    new Set([...threadRecords, ...environmentRecords].map((record) => record.contextId)),
  );
  // A record whose chip is gone from the text would put the chip back when written to the draft.
  const referenced = new Set<string>(
    collectComposerContextReferences(prompt).map((reference) => reference.contextId),
  );
  return {
    prompt,
    mentions: {
      threadContexts: threadRecords.filter((record) => referenced.has(record.contextId)),
      environmentContexts: environmentRecords.filter((record) => referenced.has(record.contextId)),
    },
  };
}

/** Appends recalled text to the draft and returns the records its mentions use. */
export function appendRewoundPrompt(
  currentPrompt: string,
  message: Pick<ComposerPromptHistoryMessage, "text" | "context">,
): Pick<ComposerPromptHistoryEntry, "prompt" | "mentions"> {
  const { prompt, mentions } = recallComposerMessage(message);
  return {
    prompt:
      prompt.length === 0
        ? currentPrompt
        : currentPrompt.length > 0
          ? `${currentPrompt}\n\n${prompt}`
          : prompt,
    mentions,
  };
}

export function buildComposerPromptHistoryEntries(
  messages: ReadonlyArray<ComposerPromptHistoryMessage>,
): ComposerPromptHistoryEntry[] {
  const entries: ComposerPromptHistoryEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    // Automations and other agents send user-role messages; recall only what the user typed.
    if (resolveUserMessagePresentation(message).attribution !== null) continue;
    const { prompt, mentions } = recallComposerMessage(message);
    if (prompt.length === 0) continue;
    const entry = { id: message.id, prompt, mentions };
    const previous = entries[entries.length - 1];
    if (previous && previous.prompt === prompt) {
      entries[entries.length - 1] = entry;
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

function recall(entry: ComposerPromptHistoryEntry): ComposerPromptHistoryStep {
  return {
    position: { entryId: entry.id, recalled: entry.prompt },
    prompt: entry.prompt,
    mentions: entry.mentions,
  };
}

export function stepComposerPromptHistory(input: {
  readonly direction: "backward" | "forward";
  readonly entries: ReadonlyArray<ComposerPromptHistoryEntry>;
  readonly position: ComposerPromptHistoryPosition | null;
  readonly currentPrompt: string;
}): ComposerPromptHistoryStep | null {
  const { entries, position, currentPrompt } = input;
  const activeIndex =
    position && position.recalled === currentPrompt ? findActive(entries, position) : -1;

  if (input.direction === "backward") {
    if (activeIndex < 0 && currentPrompt.length > 0) return null;
    const entry = entries[activeIndex < 0 ? entries.length - 1 : activeIndex - 1];
    if (!entry) return null;
    return recall(entry);
  }

  if (activeIndex < 0) return null;
  const entry = entries[activeIndex + 1];
  if (!entry) return { position: null, prompt: "", mentions: NO_MENTIONS };
  return recall(entry);
}
