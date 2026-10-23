// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { BotInfo, BotSelection } from "@gadgets/workshop-shared/api";
import {
  LAST_SELECTED_BOT_KEY,
  botSelectionKey,
  getStoredSelectedBot,
  persistSelectedBot,
  sameBotSelection,
} from "./modelSelection";

const userBot: BotInfo = {
  selection: { scope: "user", id: "3" },
  name: "Researcher",
  modelId: "claude-opus-5-5",
  available: true,
}
const deploymentBot: BotInfo = {
  selection: { scope: "deployment", id: "writer" },
  name: "Writer",
  modelId: "gpt-6",
  available: true,
}

afterEach(() => {
  localStorage.clear();
});

describe("bot selection storage", () => {
  it("persists a selection and reads it back only while it still resolves", () => {
    persistSelectedBot(userBot.selection);
    expect(getStoredSelectedBot([userBot, deploymentBot])).toEqual(userBot.selection);
    // A stored choice naming no offered bot starts intake on the default model instead.
    expect(getStoredSelectedBot([deploymentBot])).toBeNull();
  });

  it("stores the choice under the scope-qualified key format", () => {
    persistSelectedBot(userBot.selection);
    expect(localStorage.getItem(LAST_SELECTED_BOT_KEY)).toBe("user:3");
  });

  it("distinguishes a user bot from a deployment bot with the same id", () => {
    const sameIdDeployment: BotSelection = { scope: "deployment", id: "3" };
    persistSelectedBot(sameIdDeployment);
    expect(getStoredSelectedBot([userBot])).toBeNull();
    expect(getStoredSelectedBot([{ ...userBot, selection: sameIdDeployment }]))
      .toEqual(sameIdDeployment);
  });

  it("returns null with nothing stored or no bots offered", () => {
    expect(getStoredSelectedBot([userBot])).toBeNull();
    persistSelectedBot(userBot.selection);
    expect(getStoredSelectedBot([])).toBeNull();
  });

  it("clears the stored choice on null", () => {
    persistSelectedBot(userBot.selection);
    persistSelectedBot(null);
    expect(localStorage.getItem(LAST_SELECTED_BOT_KEY)).toBeNull();
    expect(getStoredSelectedBot([userBot])).toBeNull();
  });

  it("formats and compares selection keys by scope and id", () => {
    expect(botSelectionKey({ scope: "user", id: "3" })).toBe("user:3");
    expect(botSelectionKey({ scope: "deployment", id: "writer" })).toBe("deployment:writer");
    expect(sameBotSelection({ scope: "user", id: "3" }, { scope: "user", id: "3" })).toBe(true);
    expect(sameBotSelection({ scope: "user", id: "3" }, { scope: "deployment", id: "3" })).toBe(false);
    expect(sameBotSelection({ scope: "user", id: "3" }, undefined)).toBe(false);
  });
});
