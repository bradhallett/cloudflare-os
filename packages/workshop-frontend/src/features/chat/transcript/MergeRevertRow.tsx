import { ArrowUUpLeft, Check } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import { formatFullTimestamp } from "../../../utils/formatTimestamp";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";

/** The "accepted changes" / "discarded changes" marker a merge or revert leaves behind. */
export function MergeRevertRow({
  msg,
  timestamp,
}: {
  msg: Extract<AiChatMessage, { type: "merge" | "revert" }>;
  /** When the change it references was made, when known. */
  timestamp: Date | undefined;
}) {
  const isMerge = msg.type === "merge";
  return (
    <div className="max-w-[860px] py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
      <Tooltip
        content={
          isMerge
            ? `Accepted draft changes${timestamp ? ` through ${formatFullTimestamp(timestamp)}` : ""}.`
            : `Returned to the gadget state before the prompt sent ${timestamp ? `at ${timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "earlier"}.`
        }
        asChild
      >
        <span className="inline-flex items-center gap-3 px-1.5">
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
            {isMerge ? <Check size={16} /> : <ArrowUUpLeft size={16} />}
          </span>
          <span className="font-medium">
            {msg.author.name}{" "}
            {isMerge ? "accepted changes" : "discarded changes"}
          </span>
        </span>
      </Tooltip>
    </div>
  );
}
