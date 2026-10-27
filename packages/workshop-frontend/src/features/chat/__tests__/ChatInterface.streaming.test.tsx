// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatMetadata, AiChatStreamEvent, AiChatSubscriber, Overseer,
} from '@gadgets/workshop-shared/api'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
// jsdom lays nothing out; the message list scrolls itself to the bottom on every render.
Element.prototype.scrollTo = () => {}

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const Pass = ({ children }: { children?: React.ReactNode }) => children ?? null
  const Null = () => null
  const parts = new Proxy(Pass, {
    get: (_target, property) => property === 'Root' ? Null : Pass,
  })
  return {
    ...actual,
    Dialog: parts,
    DropdownMenu: parts,
    Popover: parts,
    Tooltip: Pass,
    useKumoToastManager: () => ({ add: () => {} }),
  }
})

vi.mock('../../../AuthContext', () => {
  const context = {
    authenticatedApi: { listGatekeeperVendors: async () => [], listBots: async () => [] },
    currentUser: null,
  }
  return {
    useAuthenticatedApi: () => context,
    useOptionalAuthenticatedApi: () => null,
  }
})

import { flushFrames, makeOverseer, makeTestRoot } from '../../../action-test-harness'
import * as chatDisplayEntries from '../transcript/chatDisplayEntries'
import ChatInterface from '../ChatInterface'

const testRoot = makeTestRoot()

afterEach(() => {
  testRoot.cleanup()
  vi.restoreAllMocks()
})

const CHAT_ID = 1
const AGENT = { type: 'agent', id: 'model', name: 'Model' } as const

const metadata = (activeAgent?: AiChatMetadata['activeAgent']): AiChatMetadata => ({
  id: CHAT_ID,
  title: 'Chat',
  started: new Date(1700000000000),
  lastActive: new Date(1700000000000),
  activeAgent,
})

// Opens the chat with the agent mid-turn, and hands back the surfaces the turn drives: the
// subscription's stream/message/metadata entry points.
async function openActiveChat() {
  const server = makeOverseer()
  let subscriber: AiChatSubscriber | undefined
  Object.assign(server.overseer as object, {
    getChatMessage: async () => null,
    getChatHistory: async () => ({ messages: [] }),
    listChats: async () => [metadata(AGENT)],
    listBots: async () => [],
    listModels: async () => [],
    onRpcBroken: () => {},
    subscribeToChat: (next: AiChatSubscriber) => {
      subscriber = next
      return { [Symbol.dispose]: () => {} }
    },
    viewChat: () => ({ [Symbol.dispose]: () => {} }),
  })
  await testRoot.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={server.overseer as RpcStub<Overseer>}
      selectedChatId={CHAT_ID}
      onNavigateToChat={() => {}}
      pendingConsoleLogCount={0}
      consoleLogPreview=""
      consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''}
      onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}}
      outputOfWorkpiece={() => undefined}
    />,
  )
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [] })
  return {
    stream(event: AiChatStreamEvent) {
      act(() => subscriber!.stream(CHAT_ID, event))
    },
    message(text: string) {
      act(() => subscriber!.message({
        chatId: CHAT_ID, sequence: 0, timestamp: new Date(), author: AGENT,
        type: 'message', message: text,
      }))
    },
  }
}

describe('provisional streaming renders', () => {
  // Stream deltas mutate provisional state in place; the rAF-coalesced tick is the only thing
  // that changes, so this pins the tick channel end to end (the placeholder repaints while the
  // durable transcript's memos hold) and the finalized message taking over afterwards.
  it('shows streamed text growing per tick, then replaces it with the final message', async () => {
    const chat = await openActiveChat()

    chat.stream({ type: 'textDelta', delta: 'Hello' })
    await flushFrames()
    expect(document.body.textContent).toContain('Hello')

    chat.stream({ type: 'textDelta', delta: ' world' })
    await flushFrames()
    expect(document.body.textContent).toContain('Hello world')

    chat.message('Hello world, finalized.')
    expect(document.body.textContent).toContain('Hello world, finalized.')
  })

  // M2's perf guarantee: a provisional tick repaints the streaming row without rebuilding
  // the durable transcript's entry list or message states. If currentMessages were ever
  // re-keyed on provisionalTick, these memos would re-run per tick and this test fails
  // instead of the regression passing silently.
  it('does not rebuild durable entries or message states on provisional ticks', async () => {
    const buildEntries = vi.spyOn(chatDisplayEntries, 'buildChatDisplayEntries')
    const computeStates = vi.spyOn(chatDisplayEntries, 'computeMessageStates')
    const chat = await openActiveChat()
    chat.stream({ type: 'textDelta', delta: 'Hello' })
    await flushFrames()
    const buildsAfterFirstTick = buildEntries.mock.calls.length
    const statesAfterFirstTick = computeStates.mock.calls.length

    chat.stream({ type: 'textDelta', delta: ' world' })
    await flushFrames()
    expect(document.body.textContent).toContain('Hello world')
    expect(buildEntries.mock.calls.length).toBe(buildsAfterFirstTick)
    expect(computeStates.mock.calls.length).toBe(statesAfterFirstTick)

    // A durable message changes the memo inputs, so the rebuild resumes.
    chat.message('Hello world, finalized.')
    expect(buildEntries.mock.calls.length).toBeGreaterThan(buildsAfterFirstTick)
  })
})
