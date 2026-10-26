import { ChatsIcon } from "@phosphor-icons/react";
import styles from "../ChatInterface.module.css";

/**
 * The zero-message transcript's empty state (HextaUI `empty` composition, small size: media tile,
 * title, description — the CTA is the composer itself, which the hint points at). The entrance
 * staggers tile → title → hint and degrades to nothing under reduced motion (see
 * `.emptyStateIn`).
 */
export const ChatTranscriptEmptyState = () => (
  <div className="flex flex-col items-center gap-1.5 py-16 text-center">
    <span
      className={`flex h-9 w-9 items-center justify-center rounded-[10px] bg-kumo-tint text-kumo-subtle ${styles.emptyStateIn}`}
      aria-hidden="true"
    >
      <ChatsIcon size={18} />
    </span>
    <div className={`text-[15px] leading-5 font-medium tracking-[-0.25px] text-kumo-default ${styles.emptyStateIn} ${styles.emptyStateInDelay1}`}>
      Start the conversation
    </div>
    <p className={`text-[13px] leading-[18px] text-kumo-subtle ${styles.emptyStateIn} ${styles.emptyStateInDelay2}`}>
      Send a message below — the agent picks it up from there.
    </p>
  </div>
);
