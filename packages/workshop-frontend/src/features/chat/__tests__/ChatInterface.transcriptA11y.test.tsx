// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type * as Kumo from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type {
  AiChatHistoryPage, AiChatMessage, AiChatMessageBody, AiChatMetadata, AiChatSubscriber, Overseer,
} from '@gadgets/workshop-shared/api'

// The transcript is a labelled focusable region whose content is a role="log" live region:
// appended entries announce politely, and aria-busy holds announcements while a turn streams,
// so a screen reader hears the finished message rather than per-token deltas. These tests pin
// the region's semantics and the busy toggle across a turn starting and finalizing.

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
// jsdom lays nothing out; the message list scrolls itself to the bottom on every render.
Element.prototype.scrollTo = () => {}
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 1000 })

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal<typeof Kumo>()
  const Pass = ({ children }: { children?: React.ReactNode }) => children ?? null
  const Null = () => null
  const parts = new Proxy(Pass, {
    get: (_target, property) => property === 'Root' ? Null : Pass,
  })
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return {
    ...actual,
    Dialog: parts,
    DropdownMenu: parts,
    Popover: parts,
    Tooltip: Pass,
    useKumoToastManager: () => toasts,
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

import { makeOverseer, makeTestRoot } from '../../../action-test-harness'
import ChatInterface from '../ChatInterface'

const testRoot = makeTestRoot()
// The chat store registry is module-global and keyed by workspace id, so each mount takes a
// fresh id to keep tests' chats isolated from each other.
let mountSeq = 0

afterEach(() => {
  testRoot.cleanup()
  vi.restoreAllMocks()
})

const CHAT_ID = 1
const USER = { type: 'user', id: 'dev', name: 'Dev' } as const
const AGENT = { type: 'agent', id: 'model', name: 'Model' } as const

const message = (sequence: number, body: AiChatMessageBody): AiChatMessage => ({
  chatId: CHAT_ID,
  sequence,
  timestamp: new Date(1700000000000 + sequence),
  author: USER,
  ...body,
})

// The chat as an idle turn leaves it; `activeAgent` is what the server sets while a turn runs.
const metadata = (activeAgent?: AiChatMetadata['activeAgent']): AiChatMetadata => ({
  id: CHAT_ID,
  title: 'Chat',
  started: new Date(1700000000000),
  lastActive: new Date(1700000000000),
  activeAgent,
})

const PAGE: AiChatHistoryPage = { messages: [message(1, { type: 'message', message: 'hello' })] }

const transcriptRegion = () => document.querySelector('[aria-label="Conversation transcript"]')
const transcriptLog = () => transcriptRegion()?.querySelector('[role="log"]') ?? null

// Renders the chat over a fresh overseer, as the other ChatInterface suites do, and captures the
// subscription so the test can drive the turn lifecycle the server reports through metadata.
async function openChat() {
  const server = makeOverseer()
  let subscriber: AiChatSubscriber | undefined
  Object.assign(server.overseer as object, {
    getChatMessage: async () => null,
    getChatHistory: async () => PAGE,
    listChats: async () => [metadata()],
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
      workspaceId={`ChatInterface-transcriptA11y-${++mountSeq}`}
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
    async metadataArrives(next: AiChatMetadata) {
      await act(async () => { subscriber!.metadata(next) })
    },
  }
}

it('is a labelled focusable region with the messages as its log', async () => {
  await openChat()

  const region = transcriptRegion()
  if (!(region instanceof HTMLElement)) throw new Error('transcript region not rendered')
  expect(region.getAttribute('role')).toBe('region')
  expect(region.getAttribute('tabindex')).toBe('0')

  const log = transcriptLog()
  if (!(log instanceof HTMLElement)) throw new Error('transcript log not rendered')
  expect(log.getAttribute('aria-busy')).toBe('false')
})

it('marks the log busy while a turn streams and clears it when the turn finalizes', async () => {
  const chat = await openChat()

  await chat.metadataArrives(metadata(AGENT))
  expect(transcriptLog()?.getAttribute('aria-busy')).toBe('true')

  await chat.metadataArrives(metadata())
  expect(transcriptLog()?.getAttribute('aria-busy')).toBe('false')
})
