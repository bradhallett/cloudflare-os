/** Shared chrome atoms — buttons, inputs, menus, modal headers — for the Context Library page. */

import { Button, Dialog, DropdownMenu, Input, InputArea } from "@cloudflare/kumo";
import { BookOpen, X } from "@phosphor-icons/react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { CollectionIconPicker } from "../components/CollectionIconPicker";
import { pluralize } from "./paths";

// Tile dimensions + matching fallback-book glyph size, keyed together so they can't drift.
const ICON_TILE_SIZES = {
  sm: { tile: "h-9 w-9 rounded-lg text-[18px]", book: 16 },
  md: { tile: "h-10 w-10 rounded-xl text-[20px]", book: 18 },
  lg: { tile: "h-12 w-12 rounded-2xl text-[26px]", book: 24 },
} as const;

export function CollectionIconTile({
  icon,
  size = "md",
}: {
  icon?: string;
  size?: keyof typeof ICON_TILE_SIZES;
}) {
  const { tile, book } = ICON_TILE_SIZES[size];
  return (
    <div
      className={`grid ${tile} shrink-0 place-items-center bg-kumo-fill leading-none text-kumo-subtle`}
    >
      {icon ? <span>{icon}</span> : <BookOpen size={book} weight="regular" />}
    </div>
  );
}

const wsButtonBase =
  "inline-flex cursor-pointer items-center justify-center rounded-lg text-[13px] leading-[18px] font-medium tracking-[-0.25px] transition-[background-color,color,opacity,transform] duration-150 ease-out active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100";

const wsButtonTone = {
  primary:
    "!h-9 bg-kumo-contrast px-3 text-kumo-inverse enabled:hover:bg-kumo-strong disabled:opacity-50",
  secondary:
    "!h-8 border border-kumo-line bg-kumo-base px-3 text-kumo-default enabled:hover:bg-kumo-elevated disabled:opacity-40",
  danger: "!h-8 bg-kumo-danger px-3 text-white enabled:hover:opacity-90 disabled:opacity-50",
} as const;

function buttonVariantForTone(
  tone: keyof typeof wsButtonTone,
): "primary" | "secondary" | "destructive" {
  if (tone === "primary") return "primary";
  if (tone === "danger") return "destructive";
  return "secondary";
}

export function WorkshopButton({
  tone = "secondary",
  className = "",
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "shape"> & {
  tone?: keyof typeof wsButtonTone;
}) {
  const variant = buttonVariantForTone(tone);
  return (
    <Button
      {...props}
      variant={variant}
      className={`${wsButtonBase} ${wsButtonTone[tone]} ${className}`}
    />
  );
}

export function WorkshopIconButton({
  children,
  className = "",
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "children" | "shape"> & {
  children: ReactNode;
  "aria-label": string;
}) {
  return (
    <Button
      {...props}
      variant="ghost"
      shape="square"
      className={`!flex !h-8 !w-8 shrink-0 cursor-pointer items-center justify-center rounded-md !p-0 text-kumo-subtle transition-[background-color,color,opacity,transform] duration-150 ease-out enabled:hover:bg-kumo-tint enabled:hover:text-kumo-default active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ${className}`}
    >
      {children}
    </Button>
  );
}

export function WorkshopInput({ className = "", ...props }: ComponentProps<typeof Input>) {
  return (
    <Input
      {...props}
      className={`!h-9 rounded-lg border border-kumo-line bg-kumo-base px-3 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive shadow-none focus:border-kumo-ring focus:outline-none focus:ring-1 focus:ring-kumo-ring/15 ${className}`}
    />
  );
}

export function WorkshopInputArea({ className = "", ...props }: ComponentProps<typeof InputArea>) {
  return (
    <InputArea
      {...props}
      className={`rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive shadow-none focus:border-kumo-ring focus:outline-none focus:ring-1 focus:ring-kumo-ring/15 ${className}`}
    />
  );
}

export function FieldLabel({
  children,
  optional = false,
}: {
  children: ReactNode;
  optional?: boolean;
}) {
  return (
    <label className="mb-1.5 flex items-center gap-1.5 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle">
      <span>{children}</span>
      {optional ? <span className="font-normal text-kumo-inactive">Optional</span> : null}
    </label>
  );
}

// Shared styling for the `…` overflow menus (file rows, folder rows, the tree's Add button).
const MENU_CONTENT =
  "z-[1100]! min-w-[168px]! rounded-lg border border-kumo-line bg-kumo-base p-1 shadow-[0_10px_24px_rgba(20,17,16,0.10)]";
export const MENU_ITEM =
  "h-auto! rounded-md px-2.5! py-1.5! text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default data-highlighted:bg-kumo-tint";
export const MENU_ITEM_DANGER =
  "h-auto! rounded-md px-2.5! py-1.5! text-[13px] leading-[18px] tracking-[-0.25px] data-highlighted:bg-kumo-danger-tint";

/**
 * A `…`/`+` overflow menu with the shared chrome. Tree rows pass `stopPropagation` so a click on the
 * trigger or an item doesn't also select the row behind it.
 */
export function KebabMenu({
  trigger,
  stopPropagation = false,
  children,
}: {
  trigger: ReactElement;
  stopPropagation?: boolean;
  children: ReactNode;
}) {
  const stop = stopPropagation
    ? (e: React.MouseEvent) => e.stopPropagation()
    : undefined;
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={trigger} />
      <DropdownMenu.Content
        onClick={stop}
        className={MENU_CONTENT}
        align="end"
        sideOffset={6}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/**
 * Name + description fields, shared by the New Collection page and the settings modal. Callers own
 * their layout wrappers.
 */
export function CollectionNameField({
  icon,
  onIconChange,
  value,
  onChange,
  onEnter,
  autoFocus,
}: {
  icon: string;
  onIconChange: (icon: string) => void;
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  autoFocus?: boolean;
}) {
  return (
    <>
      <FieldLabel>Name</FieldLabel>
      {/* Icon tile + name share one focus-within pill so the emoji reads as part of the input. */}
      <div className="flex items-center gap-2 rounded-xl border-2 border-kumo-line bg-kumo-base p-1.5 transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-kumo-ring focus-within:ring-1 focus-within:ring-kumo-ring/15">
        <CollectionIconPicker value={icon} onChange={onIconChange} variant="inline" />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEnter?.();
          }}
          placeholder="A short name, e.g., Brand guidelines"
          autoFocus={autoFocus}
          className="h-9 min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 pr-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive"
        />
      </div>
    </>
  );
}

export function CollectionDescriptionField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <FieldLabel optional>Description</FieldLabel>
      {/* `ring-0` drops Kumo InputArea's base ring so it matches the name pill's single border. */}
      <WorkshopInputArea
        value={value}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
        placeholder="What it contains and when to use it, e.g., voice and tone rules for customer-facing writing"
        rows={4}
        className="w-full border-2 ring-0 !rounded-xl transition-[border-color,box-shadow] duration-150 ease-out"
      />
    </>
  );
}

export function ModalHeader({
  title,
  description,
}: {
  title: string;
  description?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-4 py-5 sm:px-6">
      <div className="min-w-0">
        <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
          {title}
        </Dialog.Title>
        {description ? (
          <Dialog.Description className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
            {description}
          </Dialog.Description>
        ) : null}
      </div>
      <Dialog.Close
        render={(props) => (
          <WorkshopIconButton {...props} aria-label="Close">
            <X size={18} />
          </WorkshopIconButton>
        )}
      />
    </div>
  );
}

/**
 * Body copy for the delete-confirmation dialogs. The "… and all N documents inside it" clause shows
 * only when `documents` is passed (folders/collections with children).
 */
export function DeletePermanentlyDescription({
  name,
  documents,
}: {
  name: ReactNode;
  documents?: number;
}) {
  return (
    <>
      This permanently deletes{" "}
      <span className="font-medium text-kumo-default">{name}</span>
      {documents !== undefined ? (
        <>
          {" "}and all{" "}
          <span className="font-medium text-kumo-danger">{pluralize(documents, "document")}</span>{" "}
          inside it
        </>
      ) : null}
      . This cannot be undone.
    </>
  );
}
