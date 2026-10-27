import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import type { CompactionCheckpoint, OverseerStorage } from "./storage-schema/overseer-storage";
import { chatKey, chatKeyPrefix } from "./storage-schema/overseer-storage";
import { foldCompactedCode } from "./agent-compaction";

/**
 * The chat's compaction checkpoints: the stored checkpoint rows, the chat metadata pointer to
 * the active one, and the folds over them (publishing a new checkpoint, refolding across a
 * revert). Owned by OverseerChatRuntime as a collaborator; the compaction accessors delegate
 * to it, so checkpoint state manipulation lives in exactly one place.
 */
export class ChatCompactionStore {
  /**
   * @param storage The overseer storage (the chats and chatCompactions tables' home).
   * @param transaction The DO storage, for the atomic publish.
   */
  constructor(private storage: OverseerStorage, private transaction: DurableObjectStorage) {}

  /** Returns the checkpoint named by `chatMeta.compactedTo`. */
  getActive(chatId: number): CompactionCheckpoint | undefined {
    let compactedTo = this.storage.chatMeta.get(chatId)?.compactedTo;
    return compactedTo === undefined
        ? undefined : this.storage.chatCompactions.get(chatKey(chatId, compactedTo));
  }

  /**
   * Returns the newest checkpoint whose boundary is strictly below `sequence`, for paging
   * history backwards without selecting the checkpoint that bounds the current page.
   */
  getBelow(chatId: number, sequence: number): CompactionCheckpoint | undefined {
    // Boundaries are never negative, and keyString doesn't order negative numbers, so a
    // negative bound would select records instead of none.
    if (sequence <= 0) return undefined;
    for (let checkpoint of this.storage.chatCompactions.list({
      prefix: chatKeyPrefix(chatId),
      end: chatKey(chatId, sequence),
      reverse: true,
      limit: 1,
    })) {
      return checkpoint;
    }
    return undefined;
  }

  /**
   * Publishes a checkpoint: stores it and points the chat at it. `runAgent` produces the
   * checkpoint, for both automatic compaction and `/compact`, so there is one path here rather
   * than two.
   *
   * Safe to call after the summary's model I/O even though that releases the input gate: the
   * turn that produced this checkpoint is still the chat's active agent, and every operation
   * that could invalidate it -- merge and revert -- refuses while a turn is active. So the
   * checkpoint cannot be stale by the time it lands.
   */
  commit(chatId: number, checkpoint: CompactionCheckpoint): void {
    this.transaction.transactionSync(() => {
      let meta = this.storage.chatMeta.get(chatId);
      if (!meta) return;  // Chat deleted while the summary was being written.
      this.storage.chatCompactions.put(checkpoint);
      meta.compactedTo = checkpoint.compactedTo;
      // The prompt is about to shrink, so the recorded total no longer describes it. Without
      // this the next turn would weigh a short prompt's usage against a long one and never
      // re-trigger.
      delete meta.totalTokens;
      this.storage.chatMeta.put(meta);
    });
  }

  /**
   * Refolds each checkpoint a revert reaches into, oldest first, from the one before it. A
   * revert changes what the chat proposes, not what was said, so a checkpoint keeps its
   * boundary and summary and only the code state foldCompactedCode derives from the log
   * changes. `messages` is the chat's whole log, the revert included.
   */
  refold(chatId: number, revertFrom: number, messages: AiChatMessage[]): void {
    // The newest checkpoint whose boundary is at or before `sequence` (inclusive, because a
    // checkpoint at `revertFrom` covers only unaffected earlier messages).
    let previous = this.getBelow(chatId, revertFrom + 1);
    // Buffer the checkpoints first: rewriting them while listing would disturb the cursor.
    let affected = Array.from(this.storage.chatCompactions.list({
      prefix: chatKeyPrefix(chatId),
      start: chatKey(chatId, revertFrom + 1),
    }));
    for (let checkpoint of affected) {
      let spanStart = previous?.compactedTo ?? 0;
      previous = {
        ...checkpoint,
        ...foldCompactedCode(messages.filter(message => message.sequence >= spanStart),
                             checkpoint.compactedTo, previous),
      };
      this.storage.chatCompactions.put(previous);
    }
  }
}
