// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { AiChatAuthorInfo, BotInfo, BotSelection } from "@gadgets/workshop-shared/api";
import { ComposerModelSelector, type SelectedModel } from "./ComposerModelSelector";

// The picker is a Kumo DropdownMenu; the mock renders it open so the groups and rows are
// assertable (Trigger renders its `render` element, Content its children, Item a button that
// forwards disabled and onClick).
vi.mock("@cloudflare/kumo", () => {
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, disabled, onClick }: {
        children: ReactNode; disabled?: boolean; onClick?: () => void
      }) => (
        <button type="button" disabled={disabled} onClick={onClick}>{children}</button>
      ),
    },
  );
  return { DropdownMenu };
});

vi.mock("@phosphor-icons/react", () => ({
  CaretDown: () => <span>caret</span>,
  Check: () => <span>check</span>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const models: AiChatAuthorInfo[] = [
  { type: "agent", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { type: "agent", id: "gpt-6", name: "GPT-6" },
];

const userBot: BotInfo = {
  selection: { scope: "user", id: "3" },
  name: "Researcher",
  description: "Finds things",
  modelId: "claude-opus-5-5",
  modelName: "Claude Opus 5.5",
  available: true,
}
const deploymentBot: BotInfo = {
  selection: { scope: "deployment", id: "writer" },
  name: "Writer",
  modelId: "gpt-6",
  available: false,
  unavailableReason: "Model not available to you",
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
  vi.restoreAllMocks();
});

type RenderOptions = {
  selectedModel?: SelectedModel;
  bots?: BotInfo[];
  selectedBot?: BotSelection | null;
  onBotChange?: (bot: BotSelection | null) => void;
  showModels?: boolean;
  staleBotName?: string;
  onModelChange?: (modelId: string | null) => void;
};

function renderSelector(options: RenderOptions = {}): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const {
    selectedModel = null,
    bots,
    selectedBot = null,
    onBotChange,
    showModels,
    staleBotName,
    onModelChange = () => {},
  } = options;
  act(() => root!.render(
    <ComposerModelSelector
      models={models}
      selectedModel={selectedModel}
      onModelChange={onModelChange}
      bots={bots}
      selectedBot={selectedBot}
      onBotChange={onBotChange}
      showModels={showModels}
      staleBotName={staleBotName}
    />,
  ));
  return container;
}

const menuButtons = (): HTMLButtonElement[] =>
  [...container!.querySelectorAll("button")].slice(1); // skip the trigger

const buttonText = (button: HTMLButtonElement): string => button.textContent ?? "";

describe("ComposerModelSelector", () => {
  it("labels an offered model by its listed name", () => {
    const el = renderSelector({ selectedModel: { id: "claude-opus-5-5", name: "Stale name" } });
    expect(el.querySelector('[aria-label="Select agent"]')!.textContent).toContain("Claude Opus 5.5");
  });

  // An existing chat can still be on a model the picker has since hidden.
  it("labels a model the list doesn't offer by the chat's own name for it", () => {
    const el = renderSelector({ selectedModel: { id: "claude-opus-5", name: "Claude Opus 5" } });
    expect(el.querySelector('[aria-label="Select agent"]')!.textContent).toContain("Claude Opus 5");
  });

  it("falls back to the raw id when no name is known", () => {
    const el = renderSelector({ selectedModel: { id: "claude-opus-5" } });
    expect(el.querySelector('[aria-label="Select agent"]')!.textContent).toContain("claude-opus-5");
  });

  it("labels the trigger with the selected bot's name", () => {
    const el = renderSelector({
      bots: [userBot],
      selectedBot: userBot.selection,
      onBotChange: () => {},
      selectedModel: { id: "claude-opus-5-5" },
    });
    expect(el.querySelector('[aria-label="Select agent"]')!.textContent).toContain("Researcher");
  });

  it("offers bots with their model as the row subtitle", () => {
    renderSelector({ bots: [userBot], onBotChange: () => {} });
    const researcher = menuButtons().find((b) => buttonText(b).includes("Researcher"));
    expect(researcher).toBeDefined();
    expect(buttonText(researcher!)).toContain("Claude Opus 5.5");
  });

  it("disables an unavailable bot and shows its reason", () => {
    renderSelector({ bots: [userBot, deploymentBot], onBotChange: () => {} });
    const writer = menuButtons().find((b) => buttonText(b).includes("Writer"));
    expect(writer!.disabled).toBe(true);
    expect(buttonText(writer!)).toContain("Model not available to you");
  });

  it("hides the raw model list unless showModels, offering Default agent instead", () => {
    renderSelector({ bots: [userBot], onBotChange: () => {} });
    const texts = menuButtons().map(buttonText);
    expect(texts.some((t) => t.includes("GPT-6"))).toBe(false);
    const defaultRow = texts.find((t) => t.includes("Default agent"));
    expect(defaultRow).toBeDefined();
    expect(defaultRow).toContain(models[0].name);
  });

  it("offers the raw model list when showModels is set", () => {
    renderSelector({ bots: [userBot], onBotChange: () => {}, showModels: true });
    const texts = menuButtons().map(buttonText);
    expect(texts.some((t) => t.includes("GPT-6"))).toBe(true);
    expect(texts.some((t) => t.includes("Default agent"))).toBe(false);
  });

  it("choosing a bot reports its selection, a model its id, and No agent null", () => {
    const onBotChange = vi.fn<(bot: BotSelection | null) => void>();
    const onModelChange = vi.fn<(modelId: string | null) => void>();
    renderSelector({ bots: [userBot], onBotChange, onModelChange, showModels: true });
    const buttons = menuButtons();
    act(() => buttons.find((b) => buttonText(b).includes("Researcher"))!.click());
    expect(onBotChange).toHaveBeenCalledWith(userBot.selection);
    act(() => buttons.find((b) => buttonText(b) === "GPT-6")!.click());
    expect(onModelChange).toHaveBeenCalledWith("gpt-6");
    act(() => buttons.find((b) => buttonText(b).includes("No agent"))!.click());
    expect(onModelChange).toHaveBeenCalledWith(null);
  });

  it("choosing Default agent sends the stored (or first) model id", () => {
    const onModelChange = vi.fn<(modelId: string | null) => void>();
    renderSelector({ bots: [userBot], onBotChange: () => {}, onModelChange });
    act(() => menuButtons().find((b) => buttonText(b).includes("Default agent"))!.click());
    expect(onModelChange).toHaveBeenCalledWith(models[0].id);
  });

  it("shows a deleted chat bot as a disabled no-longer-available row", () => {
    renderSelector({ bots: [userBot], onBotChange: () => {}, staleBotName: "Ghost" });
    const ghost = menuButtons().find((b) => buttonText(b).includes("Ghost"));
    expect(ghost).toBeDefined();
    expect(ghost!.disabled).toBe(true);
    expect(buttonText(ghost!)).toContain("No longer available");
  });

  it("hides the bots group when bots cannot be chosen", () => {
    renderSelector({ bots: [userBot], selectedModel: { id: "gpt-6" } });
    const texts = menuButtons().map(buttonText);
    expect(texts.some((t) => t.includes("Researcher"))).toBe(false);
    expect(texts.some((t) => t.includes("Bots"))).toBe(false);
  });
});
