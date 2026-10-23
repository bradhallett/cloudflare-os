import { describe, expect, it } from "vitest";
import {
  MAX_BOT_DESCRIPTION_LENGTH, MAX_BOT_INSTRUCTIONS_LENGTH, MAX_BOT_NAME_LENGTH, MAX_BOT_SKILLS,
  type AlwaysAvailableResource,
} from "@gadgets/workshop-shared/api";
import {
  botKey, dedupCatalogsForBot, formatBotSection, normalizeBotDefinition, parseBotKey,
} from "../src/bot-config";

describe("normalizeBotDefinition", () => {
  it("normalizes a declaration: collapses whitespace, keeps instruction line breaks, defaults skills", () => {
    let bot = normalizeBotDefinition({
      name: "  Research\u0000\nBot ",
      description: "  Finds   papers ",
      instructions: "Be terse.\r\n\r\n  Cite  everything.\u0000Always.  ",
      modelId: " claude-sonnet ",
      skills: undefined,
    });

    expect(bot).toEqual({
      name: "Research Bot",
      description: "Finds papers",
      // \r becomes a space, spaces collapse, blanks around newlines drop.
      instructions: "Be terse.\n\nCite everything. Always.",
      modelId: "claude-sonnet",
      skills: [],
    });
  });

  it("accepts fields exactly at their caps and drops a whitespace-only description", () => {
    let bot = normalizeBotDefinition({
      name: "N".repeat(MAX_BOT_NAME_LENGTH),
      description: "   ",
      instructions: "I".repeat(MAX_BOT_INSTRUCTIONS_LENGTH),
      modelId: "m",
      skills: Array.from({length: MAX_BOT_SKILLS}, (_, i) => ({vendorId: "v", commandId: `c${i}`, name: ""})),
    });

    expect(bot.description).toBeUndefined();
    expect(bot.skills).toHaveLength(MAX_BOT_SKILLS);
    // A skill without a display name is named by its command.
    expect(bot.skills[0]).toEqual({vendorId: "v", commandId: "c0", name: "c0"});
  });

  it("drops duplicate skills by vendor and command, keeping the first", () => {
    let bot = normalizeBotDefinition({
      name: "Bot", instructions: "x", modelId: "m",
      skills: [
        {vendorId: "context", commandId: "list", name: "First"},
        {vendorId: "context", commandId: "list", name: "Second"},
        {vendorId: "context", commandId: "read", name: "Read"},
      ],
    });

    expect(bot.skills).toEqual([
      {vendorId: "context", commandId: "list", name: "First"},
      {vendorId: "context", commandId: "read", name: "Read"},
    ]);
  });

  it("refuses declarations that are not usable", () => {
    let over = (length: number) => "x".repeat(length);
    let cases: unknown[] = [
      null,
      "a string",
      {instructions: "x", modelId: "m"}, // no name
      {name: "  ", instructions: "x", modelId: "m"}, // name blank after trim
      {name: over(MAX_BOT_NAME_LENGTH + 1), instructions: "x", modelId: "m"},
      {name: "B", description: 3, instructions: "x", modelId: "m"},
      {name: "B", description: over(MAX_BOT_DESCRIPTION_LENGTH + 1), instructions: "x", modelId: "m"},
      {name: "B", modelId: "m"}, // no instructions
      {name: "B", instructions: over(MAX_BOT_INSTRUCTIONS_LENGTH + 1), modelId: "m"},
      {name: "B", instructions: "x"}, // no model
      {name: "B", instructions: "x", modelId: "  "}, // model blank after trim
      {name: "B", instructions: "x", modelId: "m", skills: "context"},
      {name: "B", instructions: "x", modelId: "m",
        skills: Array.from({length: MAX_BOT_SKILLS + 1}, (_, i) => ({vendorId: "v", commandId: `c${i}`}))},
      {name: "B", instructions: "x", modelId: "m", skills: [{commandId: "c"}]}, // no vendor
      {name: "B", instructions: "x", modelId: "m", skills: [{vendorId: "v", commandId: ""}]},
      {name: "B", instructions: "x", modelId: "m", skills: ["list"]}, // entry not an object
    ];

    for (let value of cases) {
      expect(() => normalizeBotDefinition(value)).toThrow();
    }
  });
});

describe("botKey / parseBotKey", () => {
  it("round-trips both scopes and refuses other forms", () => {
    expect(botKey({scope: "user", id: "3"})).toBe("u:3");
    expect(botKey({scope: "deployment", id: "writer"})).toBe("d:writer");

    expect(parseBotKey("u:3")).toEqual({scope: "user", id: "3"});
    expect(parseBotKey("d:writer")).toEqual({scope: "deployment", id: "writer"});
    expect(parseBotKey("u:")).toBeUndefined();
    expect(parseBotKey("d:")).toBeUndefined();
    expect(parseBotKey("x:3")).toBeUndefined();
    expect(parseBotKey("orchestrator")).toBeUndefined();
    expect(parseBotKey("")).toBeUndefined();
  });
});

describe("formatBotSection", () => {
  it("renders identity, instructions, skills and unavailable skills", () => {
    let section = formatBotSection(
        {name: "Research Bot", description: "Finds papers", instructions: "Be terse."},
        [{gatekeeperId: 7, commandId: "list-collections", title: "List collections",
          description: "Lists every readable collection"}],
        [{vendorId: "context", commandId: "deleted-cmd", name: "Deleted skill"}]);

    expect(section).toBe([
      "# Bot: Research Bot",
      "",
      "Finds papers",
      "",
      "## Instructions",
      "",
      "Be terse.",
      "",
      "## Skills",
      "",
      '- List collections — Lists every readable collection (activate with the activateSkill tool: "list-collections")',
      "",
      "## Skills not available in this workspace",
      "",
      "- Deleted skill (context:deleted-cmd)",
    ].join("\n"));
  });

  it("omits the sections it has no content for", () => {
    let section = formatBotSection({name: "Bare", instructions: "Do."}, [], []);

    expect(section).toBe("# Bot: Bare\n\n## Instructions\n\nDo.");
  });
});

describe("dedupCatalogsForBot", () => {
  let resources = (): AlwaysAvailableResource[] => [
    {name: "context", title: "Context Library", catalog: {
      entries: [
        {id: "list-collections", title: "List collections", description: "Lists"},
        {id: "read-collection", title: "Read collection", description: "Reads"},
      ],
      truncated: false,
    }},
    {name: "other", title: "Other", catalog: {
      entries: [{id: "list-collections", title: "Same id elsewhere", description: "x"}],
      truncated: false,
    }},
  ];
  let seedTargets = new Map([["context", 7], ["other", 9]]);

  it("returns resources unchanged when the bot has no skills", () => {
    expect(dedupCatalogsForBot(resources(), seedTargets, [])).toEqual(resources());
  });

  it("strips only the entries the bot's own section lists, from the workpiece offering them", () => {
    let filtered = dedupCatalogsForBot(resources(), seedTargets,
        [{gatekeeperId: 7, commandId: "list-collections"}]);

    // The same command id on a different workpiece stays; the Context entry is gone.
    expect(filtered).toEqual([
      {name: "context", title: "Context Library", catalog: {
        entries: [{id: "read-collection", title: "Read collection", description: "Reads"}],
        truncated: false,
      }},
      resources()[1],
    ]);
  });

  it("drops a resource whose catalog the bot's skills empty out", () => {
    let filtered = dedupCatalogsForBot(resources(), seedTargets,
        [{gatekeeperId: 9, commandId: "list-collections"}]);

    expect(filtered).toEqual([resources()[0]]);
  });

  it("leaves alone resources with no catalog or no seed binding", () => {
    let nullCatalog: AlwaysAvailableResource = {name: "bare", title: "Bare", catalog: null};
    let filtered = dedupCatalogsForBot(
        [...resources(), nullCatalog], new Map([["context", 7]]),
        [{gatekeeperId: 7, commandId: "list-collections"}]);

    expect(filtered).toContain(nullCatalog);
    // "other" has no binding target in this map, so its entry survives even though the id matches.
    expect(filtered).toContainEqual(resources()[1]);
    expect(filtered).toHaveLength(3);
  });
});
