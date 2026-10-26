// Declared bots, end to end: bot-scoped chat intake, subagents, inter-bot DMs, loop-safety
// budgets, and both bot scopes.
// Every turn below runs on a scripted model, so ordering is deterministic: a test's bots each
// declare their own model id (the router distinguishes scripts by account, so distinct ids may
// share one script shape), and turns that must overlap use withheld model responses (`after`) or
// never-settling ones (`pending`) to hold a thread active while another acts.
//
// The suite runs serially on purpose: the deployment-bots case writes deployment-wide admin
// config, and the re-execution case redeploys the Workshop worker mid-file, so no test may be
// concurrent with another's harness-wide effects.

import type { RpcStub } from "capnweb";
import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import type {
  AdminApi, AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiModelConfig, AuthenticatedApi,
  BotDefinition, Overseer,
} from "@gadgets/workshop-shared/api";
import { loadAllChatHistory } from "../src/agent-session.js";
import {
  ADMIN_USERNAME, startTestGatekeeperHarness, TEST_VENDOR_ID, testControl,
  type Harness,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, systemPromptOf, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, signUp, waitFor, waitForIdleChat,
  withOwnerWorkspace,
} from "../src/rpc-client.js";

let harness: Harness;
let admin: RpcStub<AdminApi>;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({handlers: [models.handler]});

// Admin config is deployment-wide, and one test redeploys the worker, so this file owns its
// harness and holds the admin session for the file's lifetime (the admin-policy suite's pattern).
const fileScope = new DisposableStack();

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness();
  const adminApi = fileScope.use(
      await signUp(fileScope.use(connect(harness.url)), ADMIN_USERNAME));
  const adminStub = fileScope.use(await adminApi.getAdminApi());
  if (adminStub === null) throw new Error("The deployment admin API was unavailable");
  admin = adminStub;
});

afterAll(async () => {
  try {
    fileScope.dispose();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

// A chat completions request: only the messages matter to the assertions below.
const REQUEST = z.looseObject({messages: z.array(z.unknown())});

type UserModel = {profile: AiChatAuthorInfo; config: AiModelConfig};
type ChatMessageEntry = Extract<AiChatMessage, {type: "message"}>;

// One user may hold several scripted models at once: the router tells scripts apart by account
// id, but the model's identity (what addModel stores and newChat resolves) is profile.id, so
// each helper-built model gets its own tagged id on both fields.
function userModelFor(model: RoutedScriptedModel, tag: string): UserModel {
  const id = `${SCRIPTED_MODEL_ID}#${tag}`;
  return {
    profile: {...model.userModel.profile, id, name: `Scripted model (${tag})`},
    config: {...model.userModel.config, model: id},
  };
}

/** A fresh user with the given models added, wired to stay alive for the test's duration. */
async function newUser(stack: DisposableStack, prefix: string, userModels: UserModel[] = []) {
  const [username] = nextUsernames(prefix);
  const api = stack.use(await signUp(stack.use(connect(harness.url)), username!));
  for (const model of userModels) await api.addModel(model.profile, model.config);
  return {username: username!, api};
}

/** Give the user's auto-provisioned ambient test account a discovery catalog. */
function setCatalog(label: string, skills: string[]): Promise<void> {
  return testControl(harness, "agent-catalog", {label, skills});
}

/** Give the account's ambient singleton slash commands: what bots declare as skills. */
function setSlashCommands(label: string, commands: {
  id: string; name: string; description: string; message: string;
}[]): Promise<void> {
  return testControl(harness, "slash-commands", {label, commands});
}

/** The user's ambient test account, provisioned, so the workspace gets its ambient capsule. */
async function ambientAccountLabel(api: RpcStub<AuthenticatedApi>): Promise<string> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the ambient account", async () =>
      (await listConnectedAccounts(api)).find(entry => entry.vendorId === TEST_VENDOR_ID) ?? null);
  return accountLabel(account);
}

function botDefinition(name: string, modelId: string, extra: Partial<BotDefinition> = {})
    : BotDefinition {
  return {
    name,
    instructions: `Standing instructions for ${name}: refuse nothing, cite everything.`,
    modelId,
    skills: [],
    ...extra,
  };
}

/** Create one of the user's own bots; its key is what the bot tools take. */
async function createBot(api: RpcStub<AuthenticatedApi>, def: BotDefinition) {
  const id = await api.createBot(def);
  return {name: def.name, selection: {scope: "user" as const, id}, key: `u:${id}`};
}

async function chatHistory(ws: RpcStub<Overseer>, chatId: number): Promise<AiChatMessage[]> {
  return loadAllChatHistory(before => ws.getChatHistory(chatId, before));
}

function messageTexts(history: AiChatMessage[]): string[] {
  const texts: string[] = [];
  for (const entry of history) if (entry.type === "message") texts.push(entry.message);
  return texts;
}

function findMessage(history: AiChatMessage[], text: string): ChatMessageEntry | undefined {
  return history.find((entry): entry is ChatMessageEntry =>
      entry.type === "message" && entry.message.includes(text));
}

/** The workspace's chats running the named bot (children included). */
async function chatsWithBotName(ws: RpcStub<Overseer>, botName: string)
    : Promise<AiChatMetadata[]> {
  return (await ws.listChats()).filter(chat => chat.botName === botName);
}

function messageBotCall(id: string, to: string, text: string) {
  return {id, name: "messageBot", arguments: {to, text}};
}

function delegateCall(id: string, bot: string, message: string, threadId?: number) {
  return {
    id, name: "delegateToBot",
    arguments: threadId === undefined ? {bot, message} : {bot, message, threadId},
  };
}

/** A batch of mid-turn DM tool calls with unique ids, to spend a budget in handfuls. */
function steerBatch(botKey: string, from: number, count: number, prefix = "filler") {
  return Array.from({length: count}, (_, index) =>
      messageBotCall(`${prefix}-${from + index}`, botKey, `${prefix} ${from + index}`));
}

it("runs a chat as a declared bot: prompt section, deduped catalog, meta, activateSkill",
    async () => {
  using stack = new DisposableStack();
  const model = models.script([
    {toolCall: {id: "activate", name: "activateSkill", arguments: {skill: "Search"}}},
    {text: "The search skill ran."},
  ]);
  const userModel = userModelFor(model, "researcher");
  const {api} = await newUser(stack, "botchat", [userModel]);
  const label = await ambientAccountLabel(api);
  await setCatalog(label, ["Search", "Travel policy"]);
  await setSlashCommands(label, [
    {id: "Search", name: "Search docs", description: "Search the shared docs.",
     message: "Search skill output: 3 hits."},
  ]);
  const bot = await createBot(api, botDefinition("Researcher", userModel.config.model, {
    description: "Finds and cites facts.",
    skills: [{vendorId: TEST_VENDOR_ID, commandId: "Search", name: "Search"}],
  }));
  // The skill the bot declares is offered both as a slash command and as a catalog entry of the
  // same connection, so dedup is observable: the catalog keeps its other entry, loses this one.
  expect(await api.listBotSkills()).toEqual([
    expect.objectContaining({vendorId: TEST_VENDOR_ID, commandId: "Search", name: "Search docs"}),
  ]);

  using ws = await api.newGadget();
  // modelId null: the bot supplies the model, which is the routed script that answers.
  const chatId = await ws.newChat("What is provable?", null,
      undefined, undefined, undefined, bot.selection);
  await waitFor("the bot chat's two model requests", async () =>
      model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);

  const prompt = systemPromptOf(model.requests[0]);
  expect(prompt).toContain("# Bot: Researcher");
  expect(prompt).toContain("Finds and cites facts.");
  expect(prompt).toContain("## Instructions");
  expect(prompt).toContain("Standing instructions for Researcher");
  expect(prompt).toContain(
      '- Search docs — Search the shared docs. (activate with the activateSkill tool: "Search")');
  // The ambient catalog survives with its other entry; the bot's skill is gone from it.
  expect(prompt).toContain("Travel policy");
  expect(prompt).not.toContain('"id":"Search"');
  // activateSkill ran the declared command and its result reached the model.
  expect(JSON.stringify(model.requests[1])).toContain("Search skill output: 3 hits.");

  const meta = (await ws.listChats()).find(chat => chat.id === chatId);
  expect(meta).toMatchObject({botName: "Researcher", bot: bot.selection});
  expect(messageTexts(await chatHistory(ws, chatId))).toContain("The search skill ran.");
});

it("delegateToBot starts a visible child thread, returns its reply, and threadId continues it",
    async () => {
  using stack = new DisposableStack();
  const {api} = await newUser(stack, "delegate");
  const writerModel = models.script([{text: "Summary: ship it."}, {text: "Risks: none found."}]);
  const writerUserModel = userModelFor(writerModel, "writer");
  const writer = await createBot(api, botDefinition("Writer", writerUserModel.config.model));
  const parentModel = models.script([
    {toolCall: delegateCall("delegate-1", writer.key, "Summarize the plan.")},
    {text: "The writer summarized the plan."},
  ]);
  const parentUserModel = userModelFor(parentModel, "parent");
  await api.addModel(writerUserModel.profile, writerUserModel.config);
  await api.addModel(parentUserModel.profile, parentUserModel.config);

  using ws = await api.newGadget();
  const chatId = await ws.newChat("Please delegate.", parentUserModel.config.model);
  await waitFor("the delegation and the parent's reply", async () =>
      parentModel.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);

  // The child is a normal visible chat, titled by its task, with the task message framed as
  // coming from another agent (never in the human's voice) and the reply the parent awaited.
  const [child] = await chatsWithBotName(ws, "Writer");
  expect(child).toMatchObject({title: "Summarize the plan.", bot: writer.selection});
  const childHistory = await chatHistory(ws, child!.id);
  const task = findMessage(childHistory, "Summarize the plan.");
  expect(task?.author.type).toBe("gadget");
  expect(task?.message).toContain("This task was sent by another agent in this workspace");
  expect(messageTexts(childHistory)).toContain("Summary: ship it.");
  const result = JSON.stringify(REQUEST.parse(parentModel.requests[1]).messages.at(-1));
  expect(result).toContain("Summary: ship it.");
  expect(result).toMatch(new RegExp(`threadId[^0-9]*${child!.id}`));

  // A follow-up that names the thread continues it: no second child, both replies on one thread.
  const followUpModel = models.script([
    {toolCall: delegateCall("delegate-2", writer.key, "Now list the risks.", child!.id)},
    {text: "The writer listed the risks."},
  ]);
  const followUpUserModel = userModelFor(followUpModel, "followup");
  await api.addModel(followUpUserModel.profile, followUpUserModel.config);
  await ws.sendChatMessage(chatId, "Follow up on the summary.", followUpUserModel.config.model);
  await waitFor("the follow-up exchange", async () => followUpModel.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  await waitForIdleChat(ws, child!.id);

  expect(await chatsWithBotName(ws, "Writer")).toHaveLength(1);
  const followUpHistory = await chatHistory(ws, child!.id);
  // The continued task carries the same agent-origin header as the first.
  expect(findMessage(followUpHistory, "Now list the risks.")?.message)
      .toContain("This task was sent by another agent in this workspace");
  expect(messageTexts(followUpHistory)).toContain("Risks: none found.");
  expect(JSON.stringify(REQUEST.parse(followUpModel.requests[1]).messages.at(-1)))
      .toContain("Risks: none found.");
});

it("refuses self-delegation, cycles, and delegations past the depth cap", async () => {
  using stack = new DisposableStack();
  const {api} = await newUser(stack, "refuse");
  // The chain under test: Alpha's chat -> Beta -> Gamma -> Delta, whose chain is at the 3-level
  // cap. Bots are created with a placeholder model first so every script can name every key;
  // updateBot then points each at its real model (updateBot keeps the id, so keys stay stable).
  const alpha = await createBot(api, botDefinition("Alpha", "unset"));
  const beta = await createBot(api, botDefinition("Beta", "unset"));
  const gamma = await createBot(api, botDefinition("Gamma", "unset"));
  const delta = await createBot(api, botDefinition("Delta", "unset"));

  const alphaModel = models.script([
    {toolCall: delegateCall("self", alpha.key, "Delegate to yourself.")},
    {toolCall: delegateCall("to-beta", beta.key, "Beta, run the middle.")},
    {text: "Alpha completed despite the refusals."},
  ]);
  const betaModel = models.script([
    {toolCall: delegateCall("cycle", alpha.key, "Alpha, you called?")},
    {toolCall: delegateCall("to-gamma", gamma.key, "Gamma, go deeper.")},
    {text: "Beta done."},
  ]);
  const gammaModel = models.script([
    {toolCall: delegateCall("to-delta", delta.key, "Delta, deepest level.")},
    {text: "Gamma done."},
  ]);
  const deltaModel = models.script([
    // Delta's chain is [Alpha, Beta, Gamma] -- length 3 -- so this is refused before any bot
    // resolution; the nonexistent key proves no lookup happened.
    {toolCall: delegateCall("past-cap", "u:999999", "One level too deep.")},
    {text: "Delta done."},
  ]);

  const userModels = [
    userModelFor(alphaModel, "alpha"), userModelFor(betaModel, "beta"),
    userModelFor(gammaModel, "gamma"), userModelFor(deltaModel, "delta"),
  ];
  await api.updateBot(alpha.selection.id, botDefinition("Alpha", userModels[0]!.config.model));
  await api.updateBot(beta.selection.id, botDefinition("Beta", userModels[1]!.config.model));
  await api.updateBot(gamma.selection.id, botDefinition("Gamma", userModels[2]!.config.model));
  await api.updateBot(delta.selection.id, botDefinition("Delta", userModels[3]!.config.model));
  for (const model of userModels) await api.addModel(model.profile, model.config);

  using ws = await api.newGadget();
  // The user's chat runs AS Alpha, so Alpha's own delegation is a self-delegation.
  const chatId = await ws.newChat("Run the chain.", null,
      undefined, undefined, undefined, alpha.selection);
  await waitFor("Alpha's turn to unwind the whole chain", async () =>
      alphaModel.requests.length === 3 || null);
  await waitForIdleChat(ws, chatId);

  expect(alphaModel.requests).toHaveLength(3);
  expect(betaModel.requests).toHaveLength(3);
  expect(gammaModel.requests).toHaveLength(2);
  expect(deltaModel.requests).toHaveLength(2);
  expect(JSON.stringify(alphaModel.requests[1])).toContain("cannot delegate to itself");
  expect(JSON.stringify(betaModel.requests[1])).toContain("(cycle)");
  expect(JSON.stringify(deltaModel.requests[1])).toContain("capped at 3 levels");
  // Every chat in the tree still completed its turn.
  expect(messageTexts(await chatHistory(ws, chatId)))
      .toContain("Alpha completed despite the refusals.");
  for (const [name, reply] of [["Beta", "Beta done."], ["Gamma", "Gamma done."],
                               ["Delta", "Delta done."]] as const) {
    const [thread] = await chatsWithBotName(ws, name);
    await waitForIdleChat(ws, thread!.id);
    expect(messageTexts(await chatHistory(ws, thread!.id))).toContain(reply);
  }
});

it("a DM to a threadless bot auto-spawns its thread, and a DM to an idle thread wakes it",
    async () => {
  using stack = new DisposableStack();
  const {api} = await newUser(stack, "dmwake");
  // The worker's first reply is held until the coordinator's turn is over, so the second DM
  // finds the worker's thread idle, not merely created.
  const workerHold = Promise.withResolvers<void>();
  const workerModel = models.script([
    {text: "Batch started.", after: workerHold.promise},
    {text: "Batch processed."},
  ]);
  const workerUserModel = userModelFor(workerModel, "worker");
  const worker = await createBot(api, botDefinition("Worker", workerUserModel.config.model));
  const coordinatorModel = models.script([
    // The coordinator's chat is the root of its tree: there is no orchestrator above it.
    {toolCalls: [messageBotCall("root-refusal", "orchestrator", "Anyone there?")]},
    {toolCall: messageBotCall("spawn", worker.key, "Please process the batch.")},
    {text: "Coordinator handed off."},
    {toolCall: messageBotCall("wake", worker.key, "Status of the batch?")},
    {text: "The worker reported."},
  ]);
  const coordinatorUserModel = userModelFor(coordinatorModel, "coordinator");
  const coordinator =
      await createBot(api, botDefinition("Coordinator", coordinatorUserModel.config.model));
  await api.addModel(workerUserModel.profile, workerUserModel.config);
  await api.addModel(coordinatorUserModel.profile, coordinatorUserModel.config);

  using ws = await api.newGadget();
  const chatId = await ws.newChat("Coordinate the batch.", null,
      undefined, undefined, undefined, coordinator.selection);
  await waitFor("the coordinator's first turn", async () =>
      coordinatorModel.requests.length === 3 || null);
  await waitForIdleChat(ws, chatId);

  expect(JSON.stringify(REQUEST.parse(coordinatorModel.requests[1]).messages.at(-1)))
      .toContain("You are the orchestrator");
  expect(JSON.stringify(REQUEST.parse(coordinatorModel.requests[2]).messages.at(-1)))
      .toContain("no thread existed, so thread");
  const [workerChat] = await chatsWithBotName(ws, "Worker");
  expect(workerChat).toMatchObject({bot: worker.selection});
  const spawned = findMessage(await chatHistory(ws, workerChat!.id), "Please process the batch.");
  expect(spawned?.message).toContain(
      `A direct message from bot "Coordinator" (${coordinator.key}) arrived mid-turn`);

  workerHold.resolve();
  await waitForIdleChat(ws, workerChat!.id);

  await ws.sendChatMessage(chatId, "Ask for status.", coordinatorUserModel.config.model);
  await waitFor("the coordinator's second turn", async () =>
      coordinatorModel.requests.length === 5 || null);
  await waitForIdleChat(ws, chatId);
  await waitForIdleChat(ws, workerChat!.id);

  expect(JSON.stringify(REQUEST.parse(coordinatorModel.requests[4]).messages.at(-1)))
      .toContain("its thread was idle, so its turn has started");
  // Still exactly one Worker thread: the wake reused the auto-spawned one.
  expect(await chatsWithBotName(ws, "Worker")).toHaveLength(1);
  const wake = findMessage(await chatHistory(ws, workerChat!.id), "Status of the batch?");
  expect(wake?.author).toMatchObject({type: "gadget", id: coordinator.key, name: "Coordinator"});
  expect(wake?.message).toContain(
      `A direct message from bot "Coordinator" (${coordinator.key}) arrived mid-turn`);
  expect(messageTexts(await chatHistory(ws, workerChat!.id))).toContain("Batch processed.");
});

it("a DM landing mid-turn queues as a steer with a provenance header", async () => {
  using stack = new DisposableStack();
  const {api} = await newUser(stack, "dmsteer");
  const workerHold = Promise.withResolvers<void>();
  const workerModel = models.script([
    {text: "Starting the batch.", after: workerHold.promise},
    {text: "Handled the batch and the retry queue."},
  ]);
  const workerUserModel = userModelFor(workerModel, "worker");
  const worker = await createBot(api, botDefinition("Worker", workerUserModel.config.model));
  const coordinatorModel = models.script([
    {toolCall: messageBotCall("spawn", worker.key, "Start the batch.")},
    {text: "Handed off."},
    {toolCall: messageBotCall("steer", worker.key, "Also handle the retry queue.")},
    {text: "Steered the worker."},
  ]);
  const coordinatorUserModel = userModelFor(coordinatorModel, "coordinator");
  const coordinator =
      await createBot(api, botDefinition("Coordinator", coordinatorUserModel.config.model));
  await api.addModel(workerUserModel.profile, workerUserModel.config);
  await api.addModel(coordinatorUserModel.profile, coordinatorUserModel.config);

  using ws = await api.newGadget();
  const chatId = await ws.newChat("Start the shift.", null,
      undefined, undefined, undefined, coordinator.selection);
  await waitFor("the coordinator's first turn", async () =>
      coordinatorModel.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);

  // The worker is mid-turn (its reply is held), so the DM queues as a steer.
  await ws.sendChatMessage(chatId, "Add the retry queue.", coordinatorUserModel.config.model);
  await waitFor("the coordinator's second turn", async () =>
      coordinatorModel.requests.length === 4 || null);
  await waitForIdleChat(ws, chatId);
  expect(JSON.stringify(REQUEST.parse(coordinatorModel.requests[3]).messages.at(-1)))
      .toContain("mid-turn");

  const [workerChat] = await chatsWithBotName(ws, "Worker");
  workerHold.resolve();
  await waitFor("the worker's steered turn", async () => workerModel.requests.length === 2 || null);
  await waitForIdleChat(ws, workerChat!.id);

  const steeredRequest = JSON.stringify(workerModel.requests[1]);
  expect(steeredRequest).toContain('A direct message from bot \\"Coordinator\\"');
  expect(steeredRequest).toContain("Also handle the retry queue.");
  const steer = findMessage(await chatHistory(ws, workerChat!.id), "Also handle the retry queue.");
  expect(steer).toMatchObject({steered: true, author: {type: "gadget", id: coordinator.key}});
  expect(messageTexts(await chatHistory(ws, workerChat!.id)))
      .toContain("Handled the batch and the retry queue.");
});

it("a bot DM to its orchestrator wakes the parent thread", async () => {
  using stack = new DisposableStack();
  const {api} = await newUser(stack, "orchwake");
  // The worker's tool-carrying reply is held until the parent's first turn is done, so the DM
  // inside it lands on an idle parent.
  const workerHold = Promise.withResolvers<void>();
  const workerModel = models.script([
    {toolCall: messageBotCall("report", "orchestrator", "Shift report: all quiet."),
     after: workerHold.promise},
    {text: "Worker signed off."},
  ]);
  const workerUserModel = userModelFor(workerModel, "worker");
  const worker = await createBot(api, botDefinition("Worker", workerUserModel.config.model));
  const parentModel = models.script([
    {toolCall: messageBotCall("spawn", worker.key, "Begin the shift.")},
    {text: "First parent turn done."},
    {text: "Parent resumed for the orchestrator DM."},
  ]);
  const parentUserModel = userModelFor(parentModel, "parent");
  const parent = await createBot(api, botDefinition("Coordinator", parentUserModel.config.model));
  await api.addModel(workerUserModel.profile, workerUserModel.config);
  await api.addModel(parentUserModel.profile, parentUserModel.config);

  using ws = await api.newGadget();
  const chatId = await ws.newChat("Run the shift.", null,
      undefined, undefined, undefined, parent.selection);
  await waitFor("the parent's first turn", async () => parentModel.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  const [workerChat] = await chatsWithBotName(ws, "Worker");
  await waitFor("the worker's held request", async () => workerModel.requests.length === 1 || null);

  workerHold.resolve();
  await waitFor("the parent's woken turn", async () => parentModel.requests.length === 3 || null);
  await waitForIdleChat(ws, chatId);
  await waitForIdleChat(ws, workerChat!.id);

  const woken = JSON.stringify(parentModel.requests[2]);
  expect(woken).toContain("Shift report: all quiet.");
  expect(woken).toContain('A direct message from bot \\"Worker\\"');
  const dm = findMessage(await chatHistory(ws, chatId), "Shift report: all quiet.");
  expect(dm?.author).toMatchObject({type: "gadget", id: worker.key, name: "Worker"});
  expect(JSON.stringify(REQUEST.parse(workerModel.requests[1]).messages.at(-1)))
      .toContain("its turn has started");
  expect(messageTexts(await chatHistory(ws, workerChat!.id))).toContain("Worker signed off.");
});

it("a DM to a bot whose model was removed visibly refuses and tells the sender", async () => {
  using stack = new DisposableStack();
  const {api} = await newUser(stack, "removedmodel");
  const workerModel = models.script([{text: "Ready."}]);
  const workerUserModel = userModelFor(workerModel, "worker");
  const worker = await createBot(api, botDefinition("Worker", workerUserModel.config.model));
  const coordinatorModel = models.script([
    {toolCall: messageBotCall("introduce", worker.key, "Introduce yourself.")},
    {text: "The worker is ready."},
    {toolCall: messageBotCall("ping", worker.key, "Ping again.")},
    {text: "The ping was refused."},
  ]);
  const coordinatorUserModel = userModelFor(coordinatorModel, "coordinator");
  const coordinator =
      await createBot(api, botDefinition("Coordinator", coordinatorUserModel.config.model));
  await api.addModel(workerUserModel.profile, workerUserModel.config);
  await api.addModel(coordinatorUserModel.profile, coordinatorUserModel.config);

  using ws = await api.newGadget();
  const chatId = await ws.newChat("Introduce the worker.", null,
      undefined, undefined, undefined, coordinator.selection);
  await waitFor("the first turn", async () => coordinatorModel.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  const [workerChat] = await chatsWithBotName(ws, "Worker");
  await waitForIdleChat(ws, workerChat!.id);

  await api.deleteModel(workerUserModel.config.model);
  // The bot now lists as unavailable: the model it declared is gone.
  const listed = (await api.listBots()).find(bot => bot.name === "Worker");
  expect(listed).toMatchObject({available: false});
  expect(listed?.unavailableReason).toBeDefined();

  await ws.sendChatMessage(chatId, "Ping the worker.", coordinatorUserModel.config.model);
  await waitFor("the refused ping", async () => coordinatorModel.requests.length === 4 || null);
  await waitForIdleChat(ws, chatId);
  await waitForIdleChat(ws, workerChat!.id);

  expect(JSON.stringify(REQUEST.parse(coordinatorModel.requests[3]).messages.at(-1)))
      .toContain("no longer available, so the message was refused");
  // The worker's thread shows the refusal (an error entry) and never got the DM text.
  const workerHistory = await chatHistory(ws, workerChat!.id);
  expect(workerHistory.at(-1)?.type).toBe("error");
  expect(messageTexts(workerHistory).some(text => text.includes("Ping again."))).toBe(false);
});

it("a chat keeps running as its bot after the bot is deleted", async () => {
  using stack = new DisposableStack();
  const model = models.script([{text: "First reply."}, {text: "Second reply, still haunted."}]);
  const userModel = userModelFor(model, "ghost");
  const {api} = await newUser(stack, "deletedbot", [userModel]);
  const bot = await createBot(api, botDefinition("Ghost", userModel.config.model));

  using ws = await api.newGadget();
  const chatId = await ws.newChat("Boo.", null, undefined, undefined, undefined, bot.selection);
  await waitFor("the first turn", async () => model.requests.length === 1 || null);
  await waitForIdleChat(ws, chatId);

  await api.deleteBot(bot.selection.id);
  expect((await api.listBots()).find(entry => entry.name === "Ghost")).toBeUndefined();
  // The chat's identity is frozen: name and selection persist in metadata (the frontend renders
  // exactly this state as the "(no longer available)" picker row).
  expect((await ws.listChats()).find(chat => chat.id === chatId))
      .toMatchObject({botName: "Ghost", bot: bot.selection});

  await ws.sendChatMessage(chatId, "Still there?", userModel.config.model);
  await waitFor("the second turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  expect(systemPromptOf(model.requests[1])).toContain("# Bot: Ghost");
  expect(messageTexts(await chatHistory(ws, chatId))).toContain("Second reply, still haunted.");
});

it("lists a collaborator-declared skill the workspace cannot resolve as unavailable", async () => {
  using stack = new DisposableStack();
  // The owner holds the ambient connection (so the workspace has its capsule); the collaborator
  // declares one skill the workspace resolves and one it cannot.
  const ownerModel = models.script([{text: "Unused."}]);
  const owner = await newUser(stack, "botowner", [userModelFor(ownerModel, "owner")]);
  const label = await ambientAccountLabel(owner.api);
  await setSlashCommands(label, [
    {id: "Search", name: "Search docs", description: "Search the shared docs.",
     message: "Search skill output: 3 hits."},
  ]);
  using ownerWs = await owner.api.newGadget();
  const workspaceId = (await ownerWs.getMetadata()).id;
  // The collaborator must exist before it can be added to the workspace (context-sharing's
  // pattern: sign up, share, open -- no restart needed between).
  const [collaboratorName] = nextUsernames("botcollab");
  const librarianModel = models.script([{text: "At your service."}]);
  const librarianUserModel = userModelFor(librarianModel, "librarian");
  const collaboratorApi =
      stack.use(await signUp(stack.use(connect(harness.url)), collaboratorName!));
  await collaboratorApi.addModel(librarianUserModel.profile, librarianUserModel.config);
  const librarian = await createBot(collaboratorApi, botDefinition("Librarian",
      librarianUserModel.config.model, {
        skills: [
          {vendorId: TEST_VENDOR_ID, commandId: "Search", name: "Search"},
          {vendorId: TEST_VENDOR_ID, commandId: "Ancient Lore", name: "Ancient Lore"},
        ],
      }));
  // The collaborator opens a workspace that uses the ambient test service, so they need their
  // own connected account for it (their label has no slash commands configured).
  await ambientAccountLabel(collaboratorApi);
  await ownerWs.addCollaborator(collaboratorName!, "build");

  using collaboratorWs = await collaboratorApi.openGadget(workspaceId);
  const chatId = await collaboratorWs.newChat("Begin the shift.", null, undefined, undefined,
      undefined, librarian.selection);
  await waitFor("the librarian's first turn", async () =>
      librarianModel.requests.length === 1 || null);
  await waitForIdleChat(collaboratorWs, chatId);

  const prompt = systemPromptOf(librarianModel.requests[0]);
  expect(prompt).toContain("# Bot: Librarian");
  expect(prompt).toContain('(activate with the activateSkill tool: "Search")');
  expect(prompt).toContain("## Skills not available in this workspace");
  expect(prompt).toContain(`- Ancient Lore (${TEST_VENDOR_ID}:Ancient Lore)`);
});

it("offers deployment bots to every user and survives the admin-config round-trip", async () => {
  using stack = new DisposableStack();
  const model = models.script([{text: "Deployment writer at work."}]);
  const userModel = userModelFor(model, "deploy");
  await admin.addDeploymentBot("writer", {
    name: "Deployment Writer",
    description: "Writes for everyone.",
    instructions: "Write deploy-ready prose.",
    modelId: userModel.config.model,
    skills: [],
  });

  const {api} = await newUser(stack, "deployuser", [userModel]);
  // The user-side read goes through the KV admin mirror: a bot missing here means the config
  // normalization dropped it.
  expect(await api.listBots()).toContainEqual(expect.objectContaining({
    selection: {scope: "deployment", id: "writer"},
    name: "Deployment Writer",
    available: true,
  }));
  expect(await admin.listDeploymentBots()).toContainEqual(
      expect.objectContaining({id: "writer", name: "Deployment Writer"}));

  using ws = await api.newGadget();
  const chatId = await ws.newChat("Write the release note.", null, undefined, undefined, undefined,
      {scope: "deployment", id: "writer"});
  await waitFor("the deployment bot's first turn", async () => model.requests.length === 1 || null);
  await waitForIdleChat(ws, chatId);

  const prompt = systemPromptOf(model.requests[0]);
  expect(prompt).toContain("# Bot: Deployment Writer");
  expect(prompt).toContain("Write deploy-ready prose.");
  expect((await ws.listChats()).find(chat => chat.id === chatId)).toMatchObject(
      {botName: "Deployment Writer", bot: {scope: "deployment", id: "writer"}});
  expect(messageTexts(await chatHistory(ws, chatId))).toContain("Deployment writer at work.");

  // A user without the declared model still sees the bot, marked unavailable.
  const bare = await newUser(stack, "bareuser");
  expect((await bare.api.listBots()).find(bot => bot.selection.id === "writer"))
      .toMatchObject({available: false});
});

it("caps a chat's inbound bot messages and refuses past the cap", async () => {
  using stack = new DisposableStack();
  const {api} = await newUser(stack, "chatbudget");
  const workerModel = models.script([
    {pending: true},          // the held first turn: every DM below lands mid-turn
    {text: "Drain reply."},   // the steer-drain turn after the test stops the held one
  ]);
  const workerUserModel = userModelFor(workerModel, "worker");
  const worker = await createBot(api, botDefinition("Worker", workerUserModel.config.model));
  const coordinatorModel = models.script([
    {toolCalls: [messageBotCall("wake", worker.key, "Wake and hold.")]},
    {toolCalls: steerBatch(worker.key, 1, 10)},
    {toolCalls: steerBatch(worker.key, 11, 10)},
    {toolCalls: steerBatch(worker.key, 21, 10)},
    {toolCalls: steerBatch(worker.key, 31, 10)},
    {toolCalls: steerBatch(worker.key, 41, 9)},  // 49 steers: the chat's 50th inbound
    {toolCalls: [messageBotCall("over", worker.key, "One message too many.")]},
    {text: "The chat budget held at fifty."},
  ]);
  const coordinatorUserModel = userModelFor(coordinatorModel, "coordinator");
  await api.addModel(workerUserModel.profile, workerUserModel.config);
  await api.addModel(coordinatorUserModel.profile, coordinatorUserModel.config);

  using ws = await api.newGadget();
  // A plain user chat (no bot): messageBot is offered because the user has delegatable bots.
  const chatId = await ws.newChat("Run the budget.", coordinatorUserModel.config.model);
  await waitFor("the coordinator's turn", async () =>
      coordinatorModel.requests.length === 8 || null);
  await waitForIdleChat(ws, chatId);

  const final = JSON.stringify(coordinatorModel.requests[7]);
  const refusal = JSON.stringify(REQUEST.parse(coordinatorModel.requests[7]).messages.at(-1));
  expect(refusal).toContain("50 of 50 for the chat");
  expect(refusal).toContain("50 of 100 for its tree");
  expect((final.match(/Delivered to u:\d+ mid-turn/g) ?? []).length).toBe(49);

  // Stop the held worker turn; its queued steers drain into one closing turn.
  const [workerChat] = await chatsWithBotName(ws, "Worker");
  await ws.stopAgent(workerChat!.id);
  await waitForIdleChat(ws, workerChat!.id);
});

it("caps the whole tree's inbound bot messages across sibling threads", async () => {
  using stack = new DisposableStack();
  const {api} = await newUser(stack, "treebudget");
  const heldTurn = () => models.script([{pending: true}, {text: "Drain reply."}]);
  const workerBModel = heldTurn();
  const workerBUserModel = userModelFor(workerBModel, "workerb");
  const workerB = await createBot(api, botDefinition("Worker B", workerBUserModel.config.model));
  const workerCModel = heldTurn();
  const workerCUserModel = userModelFor(workerCModel, "workerc");
  const workerC = await createBot(api, botDefinition("Worker C", workerCUserModel.config.model));
  // The overflow target is a real, available bot with a fresh per-chat budget: only the tree
  // cap can refuse it.
  const overflowUserModel = userModelFor(models.script([{text: "Unused."}]), "overflow");
  const overflow = await createBot(api, botDefinition("Overflow", overflowUserModel.config.model));
  await api.addModel(overflowUserModel.profile, overflowUserModel.config);
  const coordinatorModel = models.script([
    {toolCalls: [messageBotCall("spawn-b", workerB.key, "Hold B."),
                 messageBotCall("spawn-c", workerC.key, "Hold C.")]},  // tree: 2
    {toolCalls: steerBatch(workerB.key, 1, 10)},
    {toolCalls: steerBatch(workerB.key, 11, 10)},
    {toolCalls: steerBatch(workerB.key, 21, 10)},
    {toolCalls: steerBatch(workerB.key, 31, 10)},
    {toolCalls: steerBatch(workerB.key, 41, 9)},  // tree: 51
    {toolCalls: steerBatch(workerC.key, 51, 10)},
    {toolCalls: steerBatch(workerC.key, 61, 10)},
    {toolCalls: steerBatch(workerC.key, 71, 10)},
    {toolCalls: steerBatch(workerC.key, 81, 10)},
    {toolCalls: steerBatch(workerC.key, 91, 9)},  // tree: 100
    {toolCalls: [messageBotCall("overflow", overflow.key, "One tree too many.")]},
    {text: "The tree budget held at one hundred."},
  ]);
  const coordinatorUserModel = userModelFor(coordinatorModel, "coordinator");
  await api.addModel(workerBUserModel.profile, workerBUserModel.config);
  await api.addModel(workerCUserModel.profile, workerCUserModel.config);
  await api.addModel(coordinatorUserModel.profile, coordinatorUserModel.config);

  using ws = await api.newGadget();
  const chatId = await ws.newChat("Run the tree budget.", coordinatorUserModel.config.model);
  await waitFor("the coordinator's turn", async () =>
      coordinatorModel.requests.length === 13 || null);
  await waitForIdleChat(ws, chatId);

  const final = JSON.stringify(coordinatorModel.requests[12]);
  const refusal = JSON.stringify(REQUEST.parse(coordinatorModel.requests[12]).messages.at(-1));
  expect(refusal).toContain("0 of 50 for the chat");
  expect(refusal).toContain("100 of 100 for its tree");
  expect((final.match(/Delivered to u:\d+ mid-turn/g) ?? []).length).toBe(98);
  expect(await chatsWithBotName(ws, "Overflow")).toHaveLength(0);

  // Stop both held turns; their queued steers drain into one closing turn each.
  const [chatB] = await chatsWithBotName(ws, "Worker B");
  const [chatC] = await chatsWithBotName(ws, "Worker C");
  await ws.stopAgent(chatB!.id);
  await ws.stopAgent(chatC!.id);
  await waitForIdleChat(ws, chatB!.id);
  await waitForIdleChat(ws, chatC!.id);
});

it("a re-executed delegateToBot call returns the existing child instead of duplicating it",
    async () => {
  using stack = new DisposableStack();
  const {api, username} = await newUser(stack, "reexecute");
  const writerModel = models.script([
    {pending: true},                // the first attempt's request, lost with the worker restart
    {text: "The writer replied."},  // the resumed turn's response
  ]);
  const writerUserModel = userModelFor(writerModel, "writer");
  const writer = await createBot(api, botDefinition("Writer", writerUserModel.config.model));
  // The same tool call id twice: whether the restart re-executes the logged call or re-prompts
  // the model, the id the overseer sees is the one that already created the child.
  const parentModel = models.script([
    {toolCall: delegateCall("delegate-again", writer.key, "Summarize and reply.")},
    {toolCall: delegateCall("delegate-again", writer.key, "Summarize and reply.")},
    {text: "Done after the restart."},
  ]);
  const parentUserModel = userModelFor(parentModel, "parent");
  await api.addModel(writerUserModel.profile, writerUserModel.config);
  await api.addModel(parentUserModel.profile, parentUserModel.config);

  using ws = await api.newGadget();
  const chatId = await ws.newChat("Delegate, then survive a restart.",
      parentUserModel.config.model);
  await waitFor("the delegation to start and hang on the child", async () =>
      writerModel.requests.length === 1 && (await chatsWithBotName(ws, "Writer")).length === 1
          ? true : null);

  // Restart every Worker (a deploy): DO memory is lost, storage stays. Opening the workspace
  // reconstructs the Overseer, whose interrupted-turn sweep resumes both turns: the child's
  // model request is re-issued, and the parent is re-prompted from its transcript -- so the
  // scripted model repeats the same tool call id.
  await harness.redeployWorkshop();

  await withOwnerWorkspace(harness.url, username, async ws2 => {
    // The sweep that resumes the turn is alarm-driven, not client-driven, so it can already have
    // run the re-prompt *and* the scripted final reply by the time this polls; "at least" is what
    // survives that, and the assertions below pin the exact end state.
    await waitFor("the parent's turn to resume and re-prompt", async () =>
        parentModel.requests.length >= 2 || null, 60_000);
    const [resumedChild] = await chatsWithBotName(ws2, "Writer");
    await waitForIdleChat(ws2, resumedChild!.id);
    await waitForIdleChat(ws2, chatId);

    // The re-executed call answered from the durable delegation record. Whichever way the
    // restart race resolved -- the record already done, or the re-await settling on the
    // child's resumed turn -- the answer is the same reply from the same child: exactly one
    // thread, one task message, no re-billed duplicate.
    expect(await chatsWithBotName(ws2, "Writer")).toHaveLength(1);
    const history = await chatHistory(ws2, resumedChild!.id);
    expect(history.filter(entry =>
        entry.type === "message" && entry.message.includes("Summarize and reply."))).toHaveLength(1);
    expect(messageTexts(history)).toContain("The writer replied.");
    expect(messageTexts(await chatHistory(ws2, chatId))).toContain("Done after the restart.");
    expect(writerModel.requests).toHaveLength(2);
    expect(parentModel.requests).toHaveLength(3);
  });
});
