import type { AiChatMetadata } from "@gadgets/workshop-shared/api";

/**
 * Whether a chat proposes changes the client can act on: the server delivers the touched
 * workpieces (see AiChatMetadata.proposedChangeWorkpieces -- a worktree the chat only created
 * and read is not among them), so the pending-changes affordances key off this.
 */
export function chatHasProposedChanges(meta: AiChatMetadata): boolean {
  return (meta.proposedChangeWorkpieces?.length ?? 0) > 0;
}
