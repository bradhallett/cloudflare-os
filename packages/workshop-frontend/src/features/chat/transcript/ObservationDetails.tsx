import { memo } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { ActionFields, entryFields } from "../../../components/ActionFields";
import { safeExternalUrl } from "../../../utils/safeExternalUrl";
import { MarkdownMessage } from "../markdown/MarkdownMessage";
import type { ObservationChatMessage } from "./messageTypes";
import { WorkIcon } from "./WorkIcon";

/** The expanded body of one observation: what was read, from where. */
export const ObservationDetails = memo(function ObservationDetails(
  { observation }: { observation: ObservationChatMessage },
) {
  const log = observation.actionLog;
  const safeResourceUrl = safeExternalUrl(log.resourceUrl);
  const metadata = log.resourceTitle;

  return (
    <div className="px-1 py-1.5 text-[13px] leading-[19px] tracking-[-0.25px]">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={MagnifyingGlass} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 font-medium text-kumo-default">
            {log.description.title}
          </p>
          {metadata && (
            <p className="mt-0.5 mb-0 truncate text-[12px] leading-4 text-kumo-inactive">
              {safeResourceUrl && log.resourceTitle ? (
                <a
                  href={safeResourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {metadata}
                </a>
              ) : metadata}
            </p>
          )}
          <div className="mt-1.5 text-[12px] leading-[18px] tracking-[-0.2px] text-kumo-subtle">
            <MarkdownMessage message={log.description.description} />
          </div>
          <ActionFields fields={entryFields(log)} className="mt-2" />
        </div>
      </div>
    </div>
  );
});
