// =======================================================================================
// The agent's built-in tools: closures over one turn's session state (see agent-session.ts) plus
// the chat's identity. Extracted from the agent loop (agent.ts) so the loop file carries the model
// conversation and this one carries the tool surface.

import { Type } from "@earendil-works/pi-ai";
import type { TSchema } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { AGENT_SPAWNER_CONNECTION_ID, AiChatAuthorInfo, AiToolCall, validateBindingName, WorkpieceId } from "@gadgets/workshop-shared/api";
import { webFetch as webFetchImpl, formatWebFetchResult } from "./web-fetch";
import { formatGrep } from "./grep";
import {
  READ_FILE_TOOL_DESCRIPTION, CREATE_GADGET_TOOL_DESCRIPTION, CREATE_WORKTREE_TOOL_DESCRIPTION,
  GREP_TOOL_DESCRIPTION, LIST_BLUEPRINTS_TOOL_DESCRIPTION, WRITE_FILE_TOOL_DESCRIPTION,
  EDIT_FILE_TOOL_DESCRIPTION, WEBFETCH_TOOL_DESCRIPTION, OBSERVE_USER_CHANGES_TOOL_DESCRIPTION,
  OBSERVE_USER_CHANGES_NOOP_RESULT, DESCRIBE_BINDING_TOOL_DESCRIPTION,
  SET_GADGET_BINDING_TOOL_DESCRIPTION, EXECUTE_CODE_TOOL_DESCRIPTION,
  SPAWNED_EXECUTE_CODE_TOOL_DESCRIPTION, LIST_CONNECTABLE_RESOURCES_TOOL_DESCRIPTION,
  REQUEST_CONNECTION_TOOL_DESCRIPTION, CREATE_EXTERNAL_RESOURCE_TOOL_DESCRIPTION,
} from "./agent-prompt";
import { GIT_BINDING_NAME, findEditPos } from "./agent-session";
import { replaceSpanChange } from "@gadgets/workshop-shared/code-change";
import type { ChatBindingEntry } from "./storage-schema/overseer-storage";
import type { TurnSession } from "./agent-session";
import type { AgentHooks } from "./agent-hooks";

/**
 * How much text one tool result may put in front of the model. About 8k tokens: a handful of
 * results fit inside the compaction headroom of the smallest supported window. Each tool that can
 * produce more decides for itself how to stay under it in a way the model can read -- readFile
 * returns a window of whole lines with a continuation note, grep drops whole matches and says how
 * many, webFetch cuts its body and says so in the frontmatter -- rather than any tool's output
 * being spliced blindly. Tools not listed are small by construction.
 */
export const MAX_TOOL_RESULT_CHARS = 32 * 1024;

/**
 * Builds an AgentTool while keeping `execute`'s params typed by its TypeBox schema; the cast to
 * the untyped AgentTool erases the parameter type (pi validates tool-call arguments against the
 * schema before calling execute, so the runtime types are guaranteed).
 */
export function defineTool<TParameters extends TSchema>(def: AgentTool<TParameters>): AgentTool {
  return def as unknown as AgentTool;
}

/** A window into a file's lines, as readFileWindow renders it. */
export type ReadFileWindow = {startLine?: number, lineCount?: number};

/**
 * Renders a readFile result as the exact text the model sees, for both the live tool and history
 * replay. A read with no window returns the file verbatim when it fits MAX_TOOL_RESULT_CHARS;
 * otherwise, and for any windowed read, the result is the selected lines, a blank line, and
 * `[lines A-B of N; next startLine: B+1]` (without the continuation when B is the last line).
 * `lineCount` is an upper bound: a window ends where the next whole line would push the result
 * past the cap, so the note always says where to continue. Lines are never cut, so a single line
 * longer than the cap is the one result that exceeds it. Lines are 1-based; a final newline does
 * not start a line. The tool schema already requires positive integers. Exported for tests.
 */
export function readFileWindow(text: string, {startLine, lineCount}: ReadFileWindow): string {
  if (startLine === undefined && lineCount === undefined &&
      text.length <= MAX_TOOL_RESULT_CHARS) {
    return text;
  }
  let lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let first = startLine ?? 1;
  if (first > lines.length) {
    throw new Error(`startLine ${first} is past the end of the file, which has ` +
        `${lines.length} line${lines.length === 1 ? "" : "s"}.`);
  }
  let note = (last: number) => `[lines ${first}-${last} of ${lines.length}` +
      (last < lines.length ? `; next startLine: ${last + 1}]` : "]");
  // Whole lines, at least one, while they fit under the cap with the longest note this file can
  // produce.
  let limit = lineCount === undefined ? lines.length : Math.min(lines.length, first - 1 + lineCount);
  let budget = MAX_TOOL_RESULT_CHARS - note(lines.length - 1).length - 2;
  let last = first;
  let chars = lines[first - 1].length;
  while (last < limit && chars + 1 + lines[last].length <= budget) {
    chars += 1 + lines[last].length;
    ++last;
  }
  return `${lines.slice(first - 1, last).join("\n")}\n\n${note(last)}`;
}

// Describes the binding named by a `describeBinding` tool call: a name in the chat's env or,
// given `gadget`, in that gadget's own env.
async function describeBinding(
    {name, gadget}: {name: string, gadget?: string},
    chatBindings: Map<string, ChatBindingEntry>,
    chatId: number,
    hooks: Pick<AgentHooks, "describeBinding" | "describeGitBinding" | "listGadgetInfo">)
    : Promise<string> {
  if (gadget === undefined) {
    let envName = `env.${name}`;
    let entry = chatBindings.get(name);
    if (!entry && name === GIT_BINDING_NAME) return hooks.describeGitBinding(envName);
    if (!entry) throw new Error(`There is no binding named "${name}" in your env.`);
    switch (entry.type) {
      case "workpiece":
        return hooks.describeBinding(envName, entry.id, chatId);
      case "value":
        return `${envName} is the arguments array of a call delivered to this agent (one ` +
            `element per parameter of the call). Any RPC stubs among them may be called directly.`;
      default:
        return entry satisfies never;
    }
  }

  let envName = `env.${name} (in gadget ${gadget}'s env)`;
  let gadgetEntry = chatBindings.get(gadget);
  let info = gadgetEntry?.type === "workpiece"
      ? hooks.listGadgetInfo(chatId).find(candidate => candidate.id === gadgetEntry.id)
      : undefined;
  if (!info) throw new Error(`There is no gadget named "${gadget}" in your env.`);
  // Mirrors the env getEnvForLoader builds: the gadget's own edges shadow GIT and GADGET.
  let edge = info.bindings.find(binding => binding.name === name);
  if (edge) return hooks.describeBinding(envName, edge.target, chatId);
  if (name === GIT_BINDING_NAME) return hooks.describeGitBinding(envName);
  if (name === "GADGET") {
    // Unlike the gadget bindings in the agent's env, a gadget's env.GADGET is
    // the bare RPC stub.
    return `Binding: ${envName}\n` +
        `\n` +
        `This binding is an RPC stub that points at the main Durable Object instance of the ` +
        `Gadget ${JSON.stringify(info.title)} itself. Calling a method on the stub invokes the ` +
        `same-named method on the class exported by the Gadget's server.js.`;
  }
  throw new Error(`Gadget ${gadget} has no binding named "${name}".`);
}

/**
 * Builds the built-in tool set for one agent turn: every tool closure shares the turn's
 * session state and the chat's identity; bot-only tools are attached by the caller.
 */
/**
 * Renders a JSON-structured tool result as the exact text the model sees. Used by both the live
 * tools and history replay so the two can never drift.
 */
export function jsonToolResultText(value: unknown): string {
  return JSON.stringify(value);
}

  // Schema fragment for the file tools' workpiece reference. Note that although historical logs
  // allow these tool calls to omit this param, is is required in all new tool calls, hence we do
  // not describe it as optional here.
  let workpieceParam = Type.String({
    description:
        "Env binding name of the workpiece (gadget or worktree) that owns the file, as listed " +
        "in the system prompt or chosen when creating it.",
  });


/** Builds the built-in tool set for one agent turn. */
export function buildTools(deps: {
  session: TurnSession;
  hooks: AgentHooks;
  chatId: number;
  author: AiChatAuthorInfo;
  initiator: AiChatAuthorInfo;
}): Record<string, AgentTool> {
  const {session, hooks, chatId, author, initiator} = deps;
  let tools: Record<string, AgentTool> = {
    readFile: defineTool({
      name: "readFile",
      label: "Read file",
      description: READ_FILE_TOOL_DESCRIPTION,
      parameters: Type.Object({
        workpiece: workpieceParam,
        filename: Type.String({description: "Name of the file to read."}),
        startLine: Type.Optional(Type.Integer({
          minimum: 1,
          description: "First line to return, 1-based. Omit to start at the top.",
        })),
        lineCount: Type.Optional(Type.Integer({
          minimum: 1,
          description: "Number of lines to return from startLine. Omit for all remaining lines.",
        })),
      }),
      execute: async (toolCallId, {workpiece, filename, startLine, lineCount}) => {
        try {
          let resolved =
              hooks.resolveWorkpieceRoot(session.resolveToolWorkpieceId(workpiece), true, chatId);
          let window = {startLine, lineCount};

          let file = await session.readToolFile(resolved.workpieceId, filename);
          if (file === undefined) {
            throw new Error("File does not exist.");
          }
          let shown = readFileWindow(file.text, window);
          session.markFileRead(resolved.workpieceId, filename, file.oid);
          return session.toolResult(shown, file.oid === undefined ? {} : {observedOid: file.oid});
        } catch (error) {
          session.toolCallNotes.set(toolCallId, {
            error: session.toolErrorText(error)
          });
          throw error;
        }
      }
    }),

    grep: defineTool({
      name: "grep",
      label: "Search files",
      description: GREP_TOOL_DESCRIPTION,
      parameters: Type.Object({
        workpiece: workpieceParam,
        pattern: Type.String({description: "Regular expression matched against each line."}),
        path: Type.Optional(Type.String({
          description: "File or directory to search, relative to the workpiece root. Omit to " +
              "search every file.",
        })),
      }),
      execute: async (toolCallId, {workpiece, pattern, path}) => {
        try {
          let {workpieceId} =
              hooks.resolveWorkpieceRoot(session.resolveToolWorkpieceId(workpiece), true, chatId);
          let re = new RegExp(pattern);
          // The same base readFile reads from: the pin base while pinned (buffered or stored),
          // else a gadget's head fixed for the turn or a worktree's accepted commit. Session
          // content overlays it either way; a gadget with no committed code has only that.
          let base = session.pinnedGadgets.has(workpieceId)
              ? session.worktreeBase(workpieceId)
              : session.observeHead(workpieceId) ?? hooks.getWorktreePinBase(workpieceId);
          let scan = await hooks.grepWorkpiece(session.worktreeTurnAccess, workpieceId, base, path);
          // Recorded as shown: replay reads this text back, and a broad match over several
          // large files could otherwise exceed a storage record.
          let output = formatGrep(scan, re, MAX_TOOL_RESULT_CHARS);
          return session.toolResult(output, {output} as Partial<AiToolCall>);
        } catch (error) {
          session.toolCallNotes.set(toolCallId, {error: session.toolErrorText(error)});
          throw error;
        }
      }
    }),

    writeFile: defineTool({
      name: "writeFile",
      label: "Write file",
      description: WRITE_FILE_TOOL_DESCRIPTION,
      parameters: Type.Object({
        workpiece: workpieceParam,
        filename: Type.String({description: "Name of the file to write."}),
        content: Type.String({description: "The entire content of the file to write."}),
      }),
      execute: async (toolCallId, {workpiece, filename, content: newContent}) => {
        try {
          let resolved =
              hooks.resolveWorkpieceRoot(session.resolveToolWorkpieceId(workpiece), true, chatId);
          session.assertMayModifyWorkpiece(resolved.workpieceId);

          // Writing over a worktree's symlink or submodule entry is rejected with the same
          // descriptive error reading one gets, and a base *directory* path too -- such a
          // write could never commit (a whole-file write needs no readable *content*, so this
          // is the one base check the set path makes). A removed path is a new file: the base
          // entry it displaced is already gone, so no check applies.
          let base = session.worktreeBase(resolved.workpieceId);
          if (base !== undefined &&
              !session.sessionContent.get(resolved.workpieceId)?.has(filename) &&
              !session.worktreeRemovedPaths.get(resolved.workpieceId)?.has(filename)) {
            await hooks.assertWorktreePathWritable(base, filename);
          }

          // The first write to an unpinned gadget with committed code pins it at the current
          // head (a whole-file overwrite is coherent against any base, so no read gate here --
          // but the gadget's *other* stamped reads are settled against that head now, see
          // session.knowledgeAtPin). Gadgets with no committed code stay unpinned; their content
          // builds up from changes. (A worktree's first-write pin needs no declaration;
          // session.appendAgentEdit handles it.)
          let pin: {baseCommit: string, baseFiles: Map<string, string>} | undefined;
          if (!session.pinnedGadgets.has(resolved.workpieceId)) {
            let head = hooks.getGadgetHead(resolved.workpieceId);
            if (head !== undefined) {
              pin = {baseCommit: head, baseFiles: await hooks.readCommitFiles(head)};
            }
          }

          let knowledge = pin && await session.knowledgeAtPin(resolved.workpieceId, pin.baseCommit);
          // A whole-file write is a `set`: valid against any state, so replay and concurrent
          // transforms can never mis-anchor it.
          session.appendAgentEdit(resolved.workpieceId,
              {[resolved.workpieceId]: [[filename, {set: newContent}]]}, pin);
          if (knowledge !== undefined) session.filesRead.set(resolved.workpieceId, knowledge);

          // The agent knows exactly what's in the file, so add it to the `session.filesRead` set so
          // that it can make further edits without rewriting.
          session.markFileRead(resolved.workpieceId, filename);

          return session.toolResult(jsonToolResultText({success: true, changeId: session.nextChangeId}));
        } catch (error) {
          // (The preview of a failed edit is withdrawn centrally at tool_execution_end, which
          // also covers failures that never reach this execute.)
          session.toolCallNotes.set(toolCallId, {
            error: session.toolErrorText(error)
          });
          throw error;
        }
      }
    }),

    editFile: defineTool({
      name: "editFile",
      label: "Edit file",
      description: EDIT_FILE_TOOL_DESCRIPTION,
      parameters: Type.Object({
        workpiece: workpieceParam,
        filename: Type.String({description: "Name of the file to edit."}),
        textToReplace: Type.String({
          description: "Exact existing text which is to be replaced. This string must match " +
              "exactly one location in the file, or the edit will fail.",
        }),
        replacement: Type.String({
          description: "Text which should be inserted, replacing the matched text.",
        }),
        // TODO: Line number hint, to disambiguate multiple matches?
      }),
      execute: async (toolCallId, {workpiece, filename, textToReplace, replacement}) => {
        try {
          let resolved =
              hooks.resolveWorkpieceRoot(session.resolveToolWorkpieceId(workpiece), true, chatId);
          session.assertMayModifyWorkpiece(resolved.workpieceId);
          let readFiles = session.filesRead.get(resolved.workpieceId);
          if (readFiles === undefined || !readFiles.has(filename)) {
            // A file the agent never saw may not exist at all, usually a mistyped name.
            throw new Error(await session.readToolFile(resolved.workpieceId, filename) === undefined
                ? `${workpiece} has no file named "${filename}".`
                : "You must read a file before you can edit it.");
          }

          // The first edit to an unpinned gadget with committed code pins it at the *current*
          // head, so the content the model knows must be this file's content as it stands at
          // that head: the oid its knowledge is stamped with (by the unpinned read, or by the
          // epoch reset that turned session knowledge into committed knowledge) must equal the
          // file's oid at head. Knowledge of an older version -- another chat accepted since,
          // even moments ago -- does not satisfy the gate, because anchoring its content would
          // silently overwrite whatever landed. An unstamped entry (knowledge of session content
          // the workpiece no longer has) fails the same way. The same gate guards an unpinned
          // worktree's first edit, against its accepted commit (which pins it, with nothing to
          // declare; see session.appendAgentEdit).
          let pin: {baseCommit: string, baseFiles: Map<string, string>} | undefined;
          if (!session.pinnedGadgets.has(resolved.workpieceId)) {
            let head = session.unpinnedBase(resolved.workpieceId);
            if (head !== undefined) {
              let known = readFiles.get(filename);
              if (known === undefined ||
                  await hooks.fileOidAtCommit(head, filename) !== known) {
                throw new Error("The file's committed content has changed since you read it. " +
                    "Re-read the file and try again.");
              }
              if (!hooks.isWorktree(resolved.workpieceId)) {
                pin = {baseCommit: head, baseFiles: await hooks.readCommitFiles(head)};
              }
            }
          }

          // Compute the edit against the file as the agent sees it (the pinned base's content
          // when this edit establishes the pin -- byte-identical to what the read observed, per
          // the gate above; for a worktree, the accepted commit's, read by path). The matched
          // span becomes the change directly -- no diffing -- and replaceSpanChange trims the
          // unchanged disambiguation context the model padded textToReplace with, so the
          // change reports only the text that actually changed.
          let before = pin !== undefined
              ? pin.baseFiles.get(filename)
              : session.sessionContent.get(resolved.workpieceId)?.get(filename) ??
                await session.readWorktreeBase(resolved.workpieceId, filename);
          if (before === undefined) {
            throw new Error("File does not exist.");
          }
          if (typeof before !== "string") throw new Error("Binary content requires byte operations.");
          let pos = findEditPos(before, textToReplace);
          if (replacement !== textToReplace) {
            let edit = replaceSpanChange(before.length, pos, textToReplace, replacement);
            let knowledge = pin && await session.knowledgeAtPin(resolved.workpieceId, pin.baseCommit);
            session.appendAgentEdit(
                resolved.workpieceId, {[resolved.workpieceId]: [[filename, {edit}]]}, pin);
            if (knowledge !== undefined) session.filesRead.set(resolved.workpieceId, knowledge);
            // Like writeFile: the agent knows the file's exact resulting content, so the entry
            // becomes session knowledge (the gadget is pinned now, so a commit stamp -- which
            // predates this edit -- would be the wrong thing to carry forward).
            session.markFileRead(resolved.workpieceId, filename);
          } else {
            // A no-op edit appends no change row, so nothing will supersede its streamed
            // preview; withdraw it explicitly.
            session.codePreviewManager.clearPreview(toolCallId);
          }

          return session.toolResult(jsonToolResultText({success: true, changeId: session.nextChangeId}));
        } catch (error) {
          // (Failed edits' previews are withdrawn centrally at tool_execution_end.)
          session.toolCallNotes.set(toolCallId, {
            error: session.toolErrorText(error)
          });
          throw error;
        }
      }
    }),

    webFetch: defineTool({
      name: "webFetch",
      label: "Fetch web page",
      description: WEBFETCH_TOOL_DESCRIPTION,
      parameters: Type.Object({
        url: Type.String({description: "The HTTPS URL to fetch."}),
        raw: Type.Optional(Type.Boolean({
          description:
              "If true, return the exact content the server sent (HTML, JSON, etc.) " +
              "without any conversion. Default: false, which converts supported document " +
              "formats (HTML, PDF, DOCX, ...) to Markdown.",
        })),
      }),
      execute: async (toolCallId, {url, raw}) => {
        try {
          let result = await webFetchImpl(hooks.getWebFetchEnv(), {url, raw});
          // Cut the body, not the formatted result, so the frontmatter's `truncated` stays true
          // to the text and the recorded output is what the model saw. The header counts against
          // the cap too, so the formatted whole fits. Don't end on half of a surrogate pair: a
          // lone surrogate is not valid Unicode for the provider.
          let overflow = formatWebFetchResult(result).length - MAX_TOOL_RESULT_CHARS;
          if (overflow > 0) {
            let end = result.body.length - overflow;
            let last = result.body.charCodeAt(end - 1);
            if (last >= 0xd800 && last <= 0xdbff) --end;
            result = {...result, body: result.body.slice(0, end), truncated: true};
          }

          let host = new URL(result.finalUrl).host;
          await hooks.recordAgentObservation(
              chatId,
              `Web fetch: ${host}`,
              result.finalUrl,
              {
                title: `Fetched ${host}`,
                description:
                    `GET \`${result.finalUrl}\`\n\n` +
                    `Status: ${result.status}\n` +
                    `Content-Type: \`${result.contentType || "(unspecified)"}\`\n` +
                    `Body: ${result.body.length} chars` +
                    (result.truncated ? ", truncated" : ""),
              });

          let formatted = formatWebFetchResult(result);
          return session.toolResult(formatted, {output: formatted} as Partial<AiToolCall>);
        } catch (error) {
          // Record the error on the tool call so chat-history replay can render it as an
          // error tool result (matching how readFile/writeFile/etc. behave). Then rethrow
          // so the agent sees an error tool response and any underlying bug still surfaces.
          session.toolCallNotes.set(toolCallId, {error: session.toolErrorText(error)});
          throw error;
        }
      }
    }),

    observeUserChanges: defineTool({
      name: "observeUserChanges",
      label: "Observe user changes",
      description: OBSERVE_USER_CHANGES_TOOL_DESCRIPTION,
      parameters: Type.Object({}),
      execute: async () => {
        // The agent shouldn't be calling this explicitly.
        return session.toolResult(OBSERVE_USER_CHANGES_NOOP_RESULT);
      },
    }),

    describeBinding: defineTool({
      name: "describeBinding",
      label: "Describe binding",
      description: DESCRIBE_BINDING_TOOL_DESCRIPTION,
      parameters: Type.Object({
        name: Type.String({description: "Name of the binding (a property of `env`)."}),
        gadget: Type.Optional(Type.String({
          description:
              "Env binding name of a gadget. When given, `name` is a binding in that gadget's " +
              "own env (as its code sees it) rather than in yours.",
        })),
      }),
      execute: async (toolCallId, input) => {
        try {
          // Deliberately not bounded to MAX_TOOL_RESULT_CHARS: the agent can't write code
          // against a partial API description, and there is no way yet to query it
          // progressively. Recorded so replay shows the model exactly what it saw.
          let output = await describeBinding(input, session.chatBindings, chatId, hooks);
          return session.toolResult(output, {output} as Partial<AiToolCall>);
        } catch (error) {
          session.toolCallNotes.set(toolCallId, {
            error: session.toolErrorText(error)
          });
          throw error;
        }
      }
    }),

    setGadgetBinding: defineTool({
      name: "setGadgetBinding",
      label: "Bind resource to gadget",
      description: SET_GADGET_BINDING_TOOL_DESCRIPTION,
      parameters: Type.Object({
        gadget: Type.String({
          description: "Env binding name of the gadget (or agent spawner) whose bindings to modify.",
        }),
        source: Type.String({
          description: "Env binding name of the resource to wire into the gadget.",
        }),
        name: Type.Optional(Type.String({
          description:
              "Name to bind the resource under within the gadget (`env.<name>` in the gadget's " +
              "own code). Defaults to the same name as `source`. Style: ALL_CAPS_WITH_UNDERSCORES.",
        })),
      }),
      execute: async (toolCallId, {gadget, source, name}) => {
        try {
          let gadgetEntry = session.chatBindings.get(gadget);
          if (!gadgetEntry || gadgetEntry.type !== "workpiece") {
            throw new Error(`There is no gadget named "${gadget}" in your env.`);
          }
          let sourceEntry = session.chatBindings.get(source);
          if (!sourceEntry && source === GIT_BINDING_NAME) {
            throw new Error(`env.${source} is already present in every gadget's env; there is ` +
                `no need to bind it.`);
          }
          if (!sourceEntry) {
            throw new Error(`There is no binding named "${source}" in your env.`);
          }
          if (sourceEntry.type !== "workpiece") {
            throw new Error(`env.${source} holds agent callback arguments; it cannot be bound ` +
                `into a gadget.`);
          }
          let bindingName = name ?? source;

          // The addition rides the step's "changes" message (via the barrier's
          // `addedBindings`), which durably records and sequence-stamps the pending edge (see
          // addChatMessages in overseer.ts). Same-step edits share that message, so a revert
          // keeps or discards the step's work as one unit.
          hooks.addGadgetBinding(gadgetEntry.id, bindingName, sourceEntry.id, chatId);
          session.pendingAddedBindings.push(
              {gadgetId: gadgetEntry.id, name: bindingName, target: sourceEntry.id});

          // Record the resolved edge as the tool's output -- the durable record of what the
          // call did, which replay reproduces instead of re-running the tool; the model-visible
          // result is just success + the batch's change ID.
          let output = {gadgetId: gadgetEntry.id, name: bindingName, target: sourceEntry.id,
                        changeId: session.nextChangeId};
          return session.toolResult(
              jsonToolResultText({success: true, changeId: session.nextChangeId}),
              {output} as Partial<AiToolCall>);
        } catch (error) {
          session.toolCallNotes.set(toolCallId, {
            error: session.toolErrorText(error)
          });
          throw error;
        }
      }
    }),

    createGadget: defineTool({
      name: "createGadget",
      label: "Create gadget",
      description: CREATE_GADGET_TOOL_DESCRIPTION,
      parameters: Type.Object({
        title: Type.String({
          description:
              "Short, descriptive, human-readable title for the new gadget. Shown to the user.",
        }),
        bindingName: Type.String({
          description:
              "Name under which the new gadget appears in your env, and how other tools refer " +
              "to it (e.g. the file tools' `workpiece` parameter). Must be a JavaScript " +
              "identifier not already in use; style: ALL_CAPS_WITH_UNDERSCORES.",
        }),
        blueprintId: Type.Optional(Type.String({
          description:
              "If given, initialize the new gadget from this blueprint's code instead of empty. " +
              "Use the listBlueprints tool to discover available blueprint IDs.",
        })),
      }),
      execute: async (toolCallId, {title, bindingName, blueprintId}) => {
        try {
          validateBindingName(bindingName);
          if (session.isNameInScope(bindingName)) {
            throw new Error(`There is already a binding named "${bindingName}" in your env. ` +
                `Choose a different name.`);
          }

          // Fetch the blueprint (if any) before creating anything, so a bad blueprintId fails
          // cleanly without leaving an empty gadget behind.
          let blueprint = blueprintId !== undefined
              ? await hooks.fetchBlueprint(initiator, blueprintId) : undefined;

          // The gadget is created provisional to this chat: it becomes permanent only when the
          // user accepts the chat's changes. The registry record (and its name reservation) is
          // created immediately -- deferring it to the barrier would surface name conflicts
          // after the model already saw this call succeed -- but it is *stamped* by the step's
          // "changes" message, which the barrier records the creation on (see addChatMessages
          // in overseer.ts). If the step dies before its barrier, the record is reaped as an
          // unstamped orphan (see reconcilePendingGadgets) and the resumed turn just creates a
          // fresh gadget.

          // Let the transcript name the format while the call runs, as writes do with their target
          // file.
          if (blueprint?.output) {
            session.emitStreamEvent({type: "toolCallOutputFormat", toolCallId, output: blueprint.output});
          }

          let created = hooks.createGadget(title, bindingName, chatId, blueprint);
          session.pendingCreatedGadgets.push({gadgetId: created.id, title: created.title, bindingName});
          session.chatScope.rebind(bindingName, {type: "workpiece", id: created.id});

          // The creation is part of the upcoming "changes" batch; report that batch's change ID
          // (exactly as writeFile/editFile do) so reverts can be referred to precisely.
          let changeId = session.nextChangeId;

          let output: {gadgetId: WorkpieceId, changeId: number, blueprintNotes?: string} =
              {gadgetId: created.id, changeId};

          if (blueprint) {
            // Copy the blueprint's files into the new gadget as one change: like writeFile edits,
            // they ride the chat's proposed changes and revert together with the creation. The
            // new gadget is pending in this chat -- no head, hence no pin -- so its content
            // builds up from `set` changes.
            let fileChanges = Object.entries(blueprint.files)
                .map(([filename, text]): [string, {set: string}] => [filename, {set: text}]);
            if (fileChanges.length > 0) {
              session.appendAgentEdit(created.id, {[created.id]: fileChanges});
            }
            // Recorded with the creation, so that accepting it writes the release into the new
            // gadget's history and has the gadget follow the blueprint -- but only now that the
            // gadget has the release's files. The copy fails if the step has no room left for
            // it, and a gadget recorded as made from files it never got would pass for up to
            // date with the blueprint.
            session.pendingBlueprintMerges.push({gadgetId: created.id, ...blueprint.merge});
            // (The files are deliberately NOT added to session.filesRead: unlike a writeFile, the agent
            // hasn't seen their contents, so it must read before editing.)

            // The copies ride the step buffer and persist atomically with this call's record at
            // the barrier: the blueprint's contents aren't reconstructible from the call's
            // input the way writeFile edits are, so either both survive a crash or neither
            // does. (Old logs may hold the pre-barrier order -- the "changes" message *before*
            // its creating call -- which replay handles fine: the message's replay applies the
            // files, and the call's replay just returns its recorded output.)

            output.blueprintNotes = blueprint.notes;
          }

          // Persist the result as the tool's recorded output: history replay can't re-run a
          // creation tool (nor re-fetch a blueprint, whose content may have changed since), so
          // it returns this recorded value instead (see the replay path above).
          return session.toolResult(jsonToolResultText(output), {output} as Partial<AiToolCall>);
        } catch (error) {
          session.toolCallNotes.set(toolCallId, {
            error: session.toolErrorText(error)
          });
          throw error;
        }
      }
    }),

    createWorktree: defineTool({
      name: "createWorktree",
      label: "Create worktree",
      description: CREATE_WORKTREE_TOOL_DESCRIPTION,
      parameters: Type.Object({
        title: Type.String({
          description:
              "Short, descriptive, human-readable title for the new worktree. Shown to the user.",
        }),
        bindingName: Type.String({
          description:
              "Name under which the new worktree appears in your env, and how the file tools " +
              "refer to it (their `workpiece` parameter). Must be a JavaScript identifier not " +
              "already in use; style: ALL_CAPS_WITH_UNDERSCORES.",
        }),
        commitId: Type.String({
          description:
              "The git commit to root the worktree at: its full 40-hex SHA-1, exactly as " +
              "returned by the API that provided it. Abbreviated ids are not accepted.",
        }),
      }),
      execute: async (toolCallId, {title, bindingName, commitId}) => {
        try {
          validateBindingName(bindingName);
          if (session.isNameInScope(bindingName)) {
            throw new Error(`There is already a binding named "${bindingName}" in your env. ` +
                `Choose a different name.`);
          }

          // Like createGadget: the registry record (chat-private) is created immediately -- this
          // is also where the commit id resolves and, for gatekeeper-known commits, the
          // initial pull happens -- but the creation is *recorded* (and the record made
          // permanent) by the step's "changes" message at the barrier. A step that dies first
          // leaves an unstamped orphan for reconciliation. The new worktree is unpinned:
          // reads resolve lazily against its base commit (its accepted commit) until the first
          // write or commit() pins it.
          let created = await hooks.createWorktree(title, chatId, commitId);
          session.pendingCreatedWorktrees.push(
              {worktreeId: created.id, title: created.title, bindingName});
          session.chatScope.rebind(bindingName, {type: "workpiece", id: created.id});

          // Report the batch's change ID like the other creation/edit tools, and the resolved
          // full commit id (the input may have been a prefix). Recorded as the tool's output for
          // replay, which can't re-run a creation (see the replay path above).
          let output = {worktreeId: created.id, changeId: session.nextChangeId,
                        baseCommit: created.baseCommit};
          return session.toolResult(jsonToolResultText(output), {output} as Partial<AiToolCall>);
        } catch (error) {
          session.toolCallNotes.set(toolCallId, {
            error: session.toolErrorText(error)
          });
          throw error;
        }
      }
    }),

    listBlueprints: defineTool({
      name: "listBlueprints",
      label: "List blueprints",
      description: LIST_BLUEPRINTS_TOOL_DESCRIPTION,
      parameters: Type.Object({}),
      execute: async (toolCallId) => {
        try {
          let output = await hooks.listAvailableBlueprints(initiator);
          return session.toolResult(output, { output });
        } catch (error) {
          session.toolCallNotes.set(toolCallId, { error: session.toolErrorText(error) });
          throw error;
        }
      }
    }),

    executeCode: defineTool({
      name: "executeCode",
      label: "Execute code",
      description: session.agentContext.spawnerConfig
          ? SPAWNED_EXECUTE_CODE_TOOL_DESCRIPTION : EXECUTE_CODE_TOOL_DESCRIPTION,
      parameters: Type.Object({
        code: Type.String({
          description:
              "Code to execute. This must be a complete self-contained JavaScript module " +
              "which exports a single async function, like so:\n" +
              "\n" +
              "```\n" +
              "export default async function(self, env, ctx) {\n" +
              "  // ... code to execute ...\n" +
              "}\n" +
              "```\n" +
              "\n" +
              "`env` and `ctx` are the usual objects passed to Cloudflare Workers event " +
              "handlers. `env` contains the bindings, and `ctx` contains various functions " +
              "and information related to the execution context. `self` is a magic object " +
              "that points back to this chat thread.",
        }),
      }),
      execute: async (toolCallId, {code}) => {
        try {
          // Step-transactionality guard: buffered edits are durable only at the step's
          // barrier, so code must not run against content the persisted history doesn't yet
          // hold -- a crash would lose the edits the execution observed. Editing code and then
          // executing it in one step never worked; the error is retryable and tells the model
          // to split them. (Deliberately coarse: no per-gadget touched-set -- worktrees keep
          // the same rule.)
          if (session.stepBuffer.changes.length > 0) {
            throw new Error("This step already made code changes, which take effect when the " +
                "step ends. End this response and call executeCode again in your next step.");
          }

          let output = await hooks.executeCodeMode(
              chatId, code, initiator, author.id, Object.fromEntries(session.chatBindings),
              delta => session.emitStreamEvent({
                type: "toolOutputDelta",
                toolCallId,
                delta,
              }),
              session.worktreeTurnAccess);
          return session.toolResult(`${output}`, {output: `${output}`} as Partial<AiToolCall>);
        } catch (error) {
          session.toolCallNotes.set(toolCallId, {
            error: session.toolErrorText(error)
          });
          throw error;
        }
      }
    }),

    listConnectableResources: defineTool({
      name: "listConnectableResources",
      label: "List connectable resources",
      description: LIST_CONNECTABLE_RESOURCES_TOOL_DESCRIPTION,
      parameters: Type.Object({
        vendorId: Type.String({
          description: "Vendor id, as listed in the system prompt (e.g. 'github').",
        }),
      }),
      execute: async (toolCallId, {vendorId}) => {
        try {
          let output = await hooks.listConnectableResources(vendorId);
          return session.toolResult(output, { output });
        } catch (error) {
          session.toolCallNotes.set(toolCallId, { error: session.toolErrorText(error) });
          throw error;
        }
      }
    }),

    requestConnection: defineTool({
      name: "requestConnection",
      label: "Request connection",
      description: REQUEST_CONNECTION_TOOL_DESCRIPTION,
      parameters: Type.Object({
        vendorId: Type.String({
          description: "Vendor id, as listed in the system prompt (e.g. 'github'), or " +
              `'${AGENT_SPAWNER_CONNECTION_ID}' for an agent spawner.`,
        }),
        resourceUrl: Type.Optional(Type.String({
          description:
              "The specific resource URL, if known (matching a pattern from " +
              "listConnectableResources). Omit if you don't know the exact resource; the user " +
              "will pick it.",
        })),
        reason: Type.String({
          description: "A short explanation of why you need this connection, shown to the user.",
        }),
        bindingName: Type.String({
          description:
              "Name under which the resource will appear in your env once the user accepts. " +
              "Must be a JavaScript identifier not already in use; pick a name reflecting why " +
              "you want the resource. Style: ALL_CAPS_WITH_UNDERSCORES.",
        }),
      }),
      execute: async (toolCallId, input) => {
        try {
          // Validate the chosen name before creating anything. Like a server-side rejection,
          // a bad name is returned as a fixable message (not an error) so the agent can retry
          // within the same turn.
          let nameProblem: string | undefined;
          try {
            validateBindingName(input.bindingName);
          } catch (err) {
            nameProblem = `${err instanceof Error ? err.message : err}`;
          }
          if (nameProblem === undefined && session.isNameInScope(input.bindingName)) {
            nameProblem = `There is already a binding named "${input.bindingName}" in your ` +
                `env. Choose a different name.`;
          }
          if (nameProblem !== undefined) {
            let message = `Cannot request a connection: ${nameProblem}`;
            return session.toolResult(message, { output: message });
          }

          let result = await hooks.requestConnection(chatId, input);
          // Only end the turn if a request was actually created; a rejected request must let the
          // agent retry within the same turn (see the session.connectionRequested flag / finishTurn).
          if (result.requested) {
            session.connectionRequested = true;
            // The name is claimed in the chat's scope from request time (released only by
            // denial), so nothing else in this step can take it.
            session.chatScope.claim(input.bindingName);
          }
          return session.toolResult(result.message, { output: result.message });
        } catch (error) {
          session.toolCallNotes.set(toolCallId, { error: session.toolErrorText(error) });
          throw error;
        }
      }
    }),

    createExternalResource: defineTool({
      name: "createExternalResource",
      label: "Create external resource",
      description: CREATE_EXTERNAL_RESOURCE_TOOL_DESCRIPTION,
      parameters: Type.Object({
        vendorId: Type.String({
          description: "Vendor id, as listed in the system prompt (e.g. 'google').",
        }),
        resourceUrlPattern: Type.String({
          description: "urlPattern of a creatable resource type, from listConnectableResources.",
        }),
        title: Type.String({
          description: "Title of the new resource, e.g. the document's title.",
        }),
        bindingName: Type.String({
          description:
              "Name under which the new resource appears in your env. Must be a JavaScript " +
              "identifier not already in use; style: ALL_CAPS_WITH_UNDERSCORES.",
        }),
      }),
      execute: async (toolCallId, input) => {
        try {
          validateBindingName(input.bindingName);
          if (session.isNameInScope(input.bindingName)) {
            throw new Error(`There is already a binding named "${input.bindingName}" in your ` +
                `env. Choose a different name.`);
          }
          let output = await hooks.createExternalResource(chatId, input);
          session.chatScope.rebind(input.bindingName, {type: "workpiece", id: output.gatekeeperId});
          // Recorded so replay can re-bind without creating again (see the replay path above).
          return session.toolResult(jsonToolResultText(output), {output} as Partial<AiToolCall>);
        } catch (error) {
          session.toolCallNotes.set(toolCallId, { error: session.toolErrorText(error) });
          throw error;
        }
      }
    }),
  };
  return tools;
}
