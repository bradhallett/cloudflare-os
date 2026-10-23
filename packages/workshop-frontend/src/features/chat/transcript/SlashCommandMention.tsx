import type { MessageFormatRef, SlashCommandId } from "@gadgets/workshop-shared/api";
import { Tooltip } from "@cloudflare/kumo";
import { useSlashCommandChoice, type OverseerSource } from "../../../components/chat/slash-command-catalog";
import { FormatMention } from "../markdown/FormatMention";
import { TextWithMentions } from "./TextWithMentions";

// Renders a user message that invoked a slash command: their words, with the command shown back
// where they typed it and any formats they named as chips. What the command expanded into is the
// agent's context, and isn't shown.
export function SlashCommandMention(
  { name, args, id, commandPosition, formats, getOverseer }: {
    name?: string;
    args: string;
    id: SlashCommandId;
    commandPosition?: number;
    formats?: MessageFormatRef[];
    getOverseer: OverseerSource;
  },
) {
  const choice = useSlashCommandChoice(getOverseer, name ? id : undefined);
  const mention = name ? <span className="text-kumo-brand">/{name}</span> : null;
  const command = choice
    ? (
      <Tooltip
        content={
          <span className="block max-w-xs">
            {/* No `block` here: it would outrank the `-webkit-box` that line-clamp needs.
                An explicit leading is required: the clamp reserves a whole number of lines at
                the *inherited* line height, so without one the reserved box and the rendered
                lines disagree and the last line is sliced through the middle. Two lines rather
                than three keeps the whole tooltip inside its own height budget. */}
            <span className="line-clamp-2 leading-[18px]">{choice.description}</span>
            {/* Provider, then whatever identifies the command within it: for a skill that is
                its collection and path. Same line the picker shows. */}
            <span className="mt-0.5 block truncate text-kumo-subtle">
              {[choice.providerLabel, choice.resourceLabel].filter(Boolean).join(" · ")}
            </span>
          </span>
        }
        asChild
      >
        {mention}
      </Tooltip>
    )
    : mention;

  if (!name) return <>{args}</>;

  // The command was cut out of `args`, taking one adjoining space with it, so put a space back on
  // whichever side now runs into a word.
  const at = Math.min(commandPosition ?? 0, args.length);
  const spaceBefore = at > 0 && !/\s$/.test(args.slice(0, at));
  const spaceAfter = at < args.length && !/^\s/.test(args.slice(at));

  return (
    <TextWithMentions
      text={args}
      mentions={[
        {
          key: "command",
          position: at,
          length: 0,
          node: <>{spaceBefore ? " " : ""}{command}{spaceAfter ? " " : ""}</>,
        },
        ...(formats ?? []).map((format, i) => ({
          key: `format-${i}`,
          position: format.position,
          length: format.length,
          node: <FormatMention format={format} />,
        })),
      ]}
    />
  );
}
