import type { MessageFormatRef } from "@gadgets/workshop-shared/api";
import { FORMAT_ICONS } from "../../../components/format/formats";
import styles from "../../../ChatInterface.module.css";

// A format the message named, drawn the way the composer drew it. Shares the capsule's chip
// styling so a message reads the same as the draft it came from. Not a link: a format names
// nothing the user can open.
export function FormatMention({ format }: { format: MessageFormatRef }) {
  const Icon = FORMAT_ICONS[format.icon];
  return (
    <span className={styles.capsuleMention}>
      <Icon size={13} className={styles.formatMentionIcon} />
      {format.noun}
    </span>
  );
}
