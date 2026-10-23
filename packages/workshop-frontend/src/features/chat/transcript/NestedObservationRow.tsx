import { memo } from "react";
import { CaretRight, MagnifyingGlass } from "@phosphor-icons/react";
import type { ObservationChatMessage } from "./messageTypes";
import { ObservationDetails } from "./ObservationDetails";
import { WorkIcon } from "./WorkIcon";

/** One observation inside an expanded work-run group. */
export const NestedObservationRow = memo(function NestedObservationRow({
  observation,
  open,
  onToggle,
}: {
  observation: ObservationChatMessage;
  open: boolean;
  onToggle: (key: string) => void;
}) {
  const key = `observation-${observation.chatId}-${observation.sequence}`;
  const log = observation.actionLog;
  const label = `Read ${log.description.title || log.resourceTitle || "resource"}`;

  return (
    <div className="group/nested">
      <button
        type="button"
        onClick={() => onToggle(key)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={MagnifyingGlass} />
        </span>
        <span className="inline-flex min-w-0 max-w-full items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
          <span className="min-w-0 truncate">{label}</span>
          <CaretRight
            size={13}
            weight="bold"
            className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
          />
        </span>
      </button>
      {open && (
        <div className="themed-surface-inset ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3">
          <ObservationDetails observation={observation} />
        </div>
      )}
    </div>
  );
});
