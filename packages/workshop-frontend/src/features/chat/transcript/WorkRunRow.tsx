import type { WorkpieceId } from "@gadgets/workshop-shared/api";
import type { ChatDisplayEntry } from "./chatDisplayEntries";
import { CreatedWorkpieceChatCard, type CreatedWorkpieceCardInfo } from "./CreatedWorkpieceChatCard";
import { type ChangeChatMessage } from "./messageTypes";
import { type PendingTurnChanges } from "./pendingTurnChanges";
import { ToolGroupRow, turnFooterProps } from "./ToolGroupRow";
import type { ToolOutputResolver } from "./toolCalls";

/**
 * A run of agent work with no message of its own: the run's tool-call group row (carrying
 * the turn's discard footer when the turn left pending changes) plus the workpieces the run
 * created.
 */
export function WorkRunRow({
  entry,
  isAgentActive,
  lastDurablePendingChange,
  pendingChangeByTurnItemSeq,
  createdWorkpiecesByTurnItemSeq,
  expandedToolCalls,
  toggleToolCallExpansion,
  resolveToolOutput,
  onOpenGadget,
  onRevertChanges,
  className,
}: {
  entry: Extract<ChatDisplayEntry, { type: "workRun" }>;
  isAgentActive: boolean;
  lastDurablePendingChange: ChangeChatMessage | null;
  pendingChangeByTurnItemSeq: Map<number, PendingTurnChanges>;
  createdWorkpiecesByTurnItemSeq: Map<number, CreatedWorkpieceCardInfo[]>;
  expandedToolCalls: ReadonlySet<string>;
  toggleToolCallExpansion: (expansionKey: string) => void;
  resolveToolOutput: ToolOutputResolver;
  onOpenGadget: (workpieceId: WorkpieceId) => void;
  onRevertChanges: (revertFrom: number) => Promise<void>;
  className: string;
}) {
  const pendingChange = pendingChangeByTurnItemSeq.get(entry.lastMessageSequence) ?? null;
  const createdWorkpieces =
    createdWorkpiecesByTurnItemSeq.get(entry.lastMessageSequence) ?? [];
  const { workGroup } = entry;
  return (
    <div className={`${className} min-w-0 w-full max-w-[860px] space-y-2`}>
      {workGroup && (
        <ToolGroupRow
          outputOf={resolveToolOutput}
          key={workGroup.key}
          group={workGroup}
          open={expandedToolCalls.has(workGroup.key)}
          expandedKeys={expandedToolCalls}
          onToggle={toggleToolCallExpansion}
          footer={
            pendingChange
              ? turnFooterProps(
                  pendingChange,
                  pendingChange.through === lastDurablePendingChange?.sequence,
                  entry.lastMessageTimestamp,
                  isAgentActive,
                  onRevertChanges,
                )
              : undefined
          }
        />
      )}
      {createdWorkpieces.map((created) => (
        <CreatedWorkpieceChatCard
          key={created.workpieceId}
          created={created}
          onOpen={() => onOpenGadget(created.workpieceId)}
        />
      ))}
    </div>
  );
}
