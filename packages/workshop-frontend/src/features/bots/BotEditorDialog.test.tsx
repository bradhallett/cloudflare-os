// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import { MAX_BOT_SKILLS, type BotDefinition, type BotSkillChoice } from "@gadgets/workshop-shared/api";
import { BotEditorDialog } from "./BotEditorDialog";

// Kumo's primitives are swapped for native controls: Dialog renders through, Checkbox becomes an
// input, and Select becomes a select that reports picks the way the real one does.
vi.mock("@cloudflare/kumo", () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <dialog open>{children}</dialog>,
    {
      Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: object) => ReactNode }) => <>{render({})}</>,
    },
  )
  const Checkbox = ({ label, checked, disabled, onCheckedChange }: {
    label: ReactNode; checked?: boolean; disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void
  }) => (
    <label>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onClick={() => {
          // React restores a controlled checkbox's DOM state before the handler runs, so the
          // intended next state comes from the prop flip, not the (reverted) DOM value.
          if (!disabled) onCheckedChange?.(checked !== true)
        }}
      />
      {label}
    </label>
  )
  const Select = ({ label, value, disabled, onValueChange, render, children }: {
    label?: ReactNode; value: string | null; disabled?: boolean;
    onValueChange?: (value: string | null, details: { reason: string }) => void;
    render?: (props: Record<string, unknown>) => ReactNode;
    children: ReactNode
  }) => {
    const control = (
      <select
        disabled={disabled}
        value={value ?? undefined}
        onChange={(event) => onValueChange?.(event.target.value, { reason: "item-press" })}
      >
        {children}
      </select>
    )
    return (
      <label>
        {label}
        {/* render replaces the trigger, as Base UI's does; the native select stands in for it. */}
        {render ? render({ children: control }) : control}
      </label>
    )
  }
  Select.Option = ({ value, children }: { value: string | null; children: ReactNode }) => (
    <option value={value ?? undefined}>{children}</option>
  )
  return {
    Dialog,
    Checkbox,
    Select,
    useKumoToastManager: () => ({ add: () => {} }),
  };
});

vi.mock("@phosphor-icons/react", () => ({
  X: () => <span>x</span>,
}));

vi.mock("../../components/WorkshopControls", () => ({
  WorkshopInput: (props: Record<string, unknown> & { value?: string }) => (
    <input type="text" {...props} />
  ),
  WorkshopInputArea: (props: Record<string, unknown> & { value?: string }) => (
    <textarea {...props} />
  ),
  WorkshopButton: ({ children, disabled, onClick, type }: {
    children: ReactNode; disabled?: boolean; onClick?: () => void; type?: "submit" | "button"
  }) => (
    <button type={type ?? "button"} disabled={disabled} onClick={onClick}>{children}</button>
  ),
  WorkshopIconButton: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const models = [
  { type: "agent" as const, id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { type: "agent" as const, id: "gpt-6", name: "GPT-6" },
]

const skills: BotSkillChoice[] = [
  { vendorId: "context", commandId: "search-notes", name: "Search notes", description: "d", providerLabel: "Context" },
  { vendorId: "context", commandId: "save-note", name: "Save note", description: "d", providerLabel: "Context" },
]

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
})

// React's controlled inputs swallow programmatic writes made through the value/checked property
// directly; route them through the prototype setter so the dispatched event is seen as a change.
function setNativeValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string | boolean,
): void {
  const isSelect = element instanceof HTMLSelectElement
  const descriptor = isSelect || typeof value === "string"
    ? Object.getOwnPropertyDescriptor(
        isSelect ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")
    : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")
  descriptor!.set!.call(element, value)
  element.dispatchEvent(
    typeof value === "boolean"
      ? new MouseEvent("click", { bubbles: true })
      : new Event(isSelect ? "change" : "input", { bubbles: true }))
}


// Renders one dialog into a fresh container, sharing the describe's root/container teardown.
const renderDialog = (props: Partial<ComponentProps<typeof BotEditorDialog>> = {}) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(
    <BotEditorDialog
      models={models}
      skills={skills}
      title="New bot"
      onSave={() => {}}
      onClose={() => {}}
      {...props}
    />,
  ));
  return container!;
};

describe("BotEditorDialog", () => {
  it("shows a linked, announced name error on a Save attempt with an empty name, and clears it on input", async () => {
    const onSave = vi.fn<(def: BotDefinition) => Promise<void>>()
    const view = renderDialog({ onSave });
    const nameInput = view.querySelector<HTMLInputElement>('input[placeholder="Research assistant"]')!
    // Save stays clickable with an empty name: the attempt is what reveals the error.
    const save = [...view.querySelectorAll("button")].find((b) => b.textContent === "Save")!
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(onSave).not.toHaveBeenCalled();
    const error = view.querySelector("#bot-editor-name-error")!
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe("Give the bot a name.");
    expect(nameInput.getAttribute("aria-invalid")).toBe("true");
    expect(nameInput.getAttribute("aria-describedby")).toBe("bot-editor-name-error");
    act(() => setNativeValue(nameInput, "Helper"));
    expect(view.querySelector("#bot-editor-name-error")).toBeNull();
    expect(nameInput.getAttribute("aria-invalid")).toBe("false");
    await act(async () => save.click());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: "Helper" }));
  });

  it("announces and focuses the model error when a Save attempt finds no model picked", async () => {
    const onSave = vi.fn<(def: BotDefinition) => Promise<void>>()
    const view = renderDialog({ models: [], onSave });
    const nameInput = view.querySelector<HTMLInputElement>('input[placeholder="Research assistant"]')!
    act(() => setNativeValue(nameInput, "Helper"));
    const save = [...view.querySelectorAll("button")].find((b) => b.textContent === "Save")!
    await act(async () => save.click());
    expect(onSave).not.toHaveBeenCalled();
    const error = view.querySelector("#bot-editor-model-error")!
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe("Pick a model for the bot to run.");
    const modelTrigger = [...view.querySelectorAll("button")].find((b) =>
      b.getAttribute("aria-describedby") === "bot-editor-model-error")!;
    expect(modelTrigger.getAttribute("aria-invalid")).toBe("true");
    // The invalid model select is where the user lands, since the name is already valid.
    expect(document.activeElement).toBe(modelTrigger);
  });

  it("hands back a trimmed name, no description for a blank one, and picked skills", async () => {
    const onSave = vi.fn<(def: BotDefinition) => Promise<void>>()
    const view = renderDialog({ onSave });
    const nameInput = view.querySelector<HTMLInputElement>('input[placeholder="Research assistant"]')!
    const descriptionInput =
      view.querySelector<HTMLInputElement>('input[placeholder="What this bot is for, in one line"]')!
    const modelSelect = view.querySelector<HTMLSelectElement>("select")!
    act(() => {
      setNativeValue(nameInput, "  Helper  ")
      setNativeValue(descriptionInput, "   ")
    })
    act(() => setNativeValue(modelSelect, "gpt-6"))
    const searchNotes =
      [...view.querySelectorAll("label")].find((l) => l.textContent?.includes("Search notes"))!
        .querySelector("input")!
    act(() => setNativeValue(searchNotes, true))
    const save = [...view.querySelectorAll("button")].find((b) => b.textContent === "Save")!
    await act(async () => save.click());
    expect(onSave).toHaveBeenCalledWith({
      name: "Helper",
      description: undefined,
      instructions: "",
      modelId: "gpt-6",
      skills: [{ vendorId: "context", commandId: "search-notes", name: "Search notes" }],
    })
  })

  it("keeps a declared skill the workspace no longer offers in the saved declaration", async () => {
    const onSave = vi.fn<(def: BotDefinition) => Promise<void>>()
    const gone: BotDefinition = {
      name: "Keeper",
      instructions: "",
      modelId: "claude-opus-5-5",
      skills: [{ vendorId: "github", commandId: "open-pr", name: "Open PR" }],
    }
    const view = renderDialog({ initial: gone, title: "Edit bot", onSave });
    const save = [...view.querySelectorAll("button")].find((b) => b.textContent === "Save")!
    await act(async () => save.click());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      skills: [{ vendorId: "github", commandId: "open-pr", name: "Open PR" }],
    }))
  })

  it("refuses skills beyond the declaration cap", () => {
    const full: BotDefinition = {
      name: "Maxed",
      instructions: "",
      modelId: "claude-opus-5-5",
      skills: Array.from({ length: MAX_BOT_SKILLS }, (_, i) => ({
        vendorId: "context", commandId: `skill-${i}`, name: `Skill ${i}`,
      })),
    }
    const view = renderDialog({ initial: full, title: "Edit bot" });
    // Every offered skill the bot doesn't already have is disabled: the cap is reached.
    const searchNotes =
      [...view.querySelectorAll("label")].find((l) => l.textContent?.includes("Search notes"))!
        .querySelector("input")!
    expect(searchNotes.disabled).toBe(true)
  })

  it("shakes the name input once after a Save attempt finds it empty (not under reduced motion)", () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "performance", "requestAnimationFrame", "cancelAnimationFrame"],
    });
    const matchMedia = vi.fn<(query: string) => { matches: boolean }>().mockReturnValue({
      matches: false,
    });
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      const view = renderDialog();
      const nameInput = view.querySelector<HTMLInputElement>('input[placeholder="Research assistant"]')!
      const save = [...view.querySelectorAll("button")].find((b) => b.textContent === "Save")!
      // No shake before any attempt, even once the field is invalid.
      act(() => nameInput.setAttribute("aria-invalid", "true"));
      act(() => vi.advanceTimersByTime(1000));
      expect(nameInput.hasAttribute("data-shake")).toBe(false);
      act(() => save.click());
      act(() => vi.advanceTimersByTime(50)); // run the requestAnimationFrame check
      expect(nameInput.hasAttribute("data-shake")).toBe(true);
      act(() => vi.advanceTimersByTime(500));
      expect(nameInput.hasAttribute("data-shake")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
})
