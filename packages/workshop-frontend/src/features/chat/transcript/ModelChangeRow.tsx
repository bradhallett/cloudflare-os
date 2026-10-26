import { Swap } from "@phosphor-icons/react";
import type { ChatDisplayEntry } from "./chatDisplayEntries";

/** The "Switched to <agent>" marker between replies from different agents. */
export function ModelChangeRow({
  entry,
  className,
}: {
  entry: Extract<ChatDisplayEntry, { type: "modelChange" }>;
  className: string;
}) {
  return (
    <div className={`${className} max-w-[860px] py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle`}>
      <div className="flex items-center gap-3 px-1.5 py-1">
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
          <Swap size={16} />
        </span>
        <span className="min-w-0 truncate">
          Switched to {entry.author.name}
        </span>
      </div>
    </div>
  );
}
