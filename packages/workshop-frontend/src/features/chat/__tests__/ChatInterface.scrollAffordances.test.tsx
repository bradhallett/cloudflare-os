// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Kumo from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type {
  AiChatMessage, AiChatMetadata, AiChatSubscriber, Overseer,
} from '@gadgets/workshop-shared/api'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
// jsdom lays nothing out. scrollTo() is recorded and drives the pinned scrollTop, so the
// assertions can distinguish "scrolled to the live edge" from "anchored near the top".
let scrollToCalls: number[] = []
beforeEach(() => {
  scrollToCalls = []
  Element.prototype.scrollTo = function (this: HTMLElement, arg?: ScrollToOptions | number) {
    const top = typeof arg === 'object' && arg !== null ? arg.top : arg
    if (top !== undefined) {
      scrollToCalls.push(top)
      this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight))
    }
  } as typeof Element.prototype.scrollTo
})
afterEach(() => {
  testRoot.cleanup()
  vi.restoreAllMocks()
})

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof Kumo
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

function withChatApi(server: { overseer: RpcStub<Overseer> }, chats: AiChatMetadata[]) {
  let subscriber: AiChatSubscriber | undefined
  Object.assign(server.overseer as object, {
    getChatMessage: async () => null,
    getChatHistory: async () => ({ messages: [] }),
    listChats: async () => chats,
    listBots: async () => [],
    listModels: async () => [],
    onRpcBroken: () => {},
    subscribeToChat: (next: AiChatSubscriber) => {
      subscriber = next
      return { [Symbol.dispose]: () => {} }
    },
    viewChat: () => ({ [Symbol.dispose]: () => {} }),
  })
  return {
    emitMessage(message: AiChatMessage) {
      act(() => subscriber!.message(message))
    },
    emitMetadata(chat: AiChatMetadata) {
      act(() => subscriber!.metadata(chat))
    },
  }
}

async function renderChat(overseer: RpcStub<Overseer>, selectedChatId: number) {
  await testRoot.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={overseer}
      selectedChatId={selectedChatId}
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
}

const openChat = { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() }
const activeAgent = { type: 'agent', id: 'model', name: 'Model' } as const

const agentMessage = (sequence: number, text: string) =>
  ({
    chatId: 1,
    sequence,
    timestamp: new Date(),
    author: activeAgent,
    type: 'message',
    message: text,
  }) as AiChatMessage

const userMessage = (sequence: number, text: string) =>
  ({
    chatId: 1,
    sequence,
    timestamp: new Date(),
    author: { type: 'user', id: 'me', name: 'Me' },
    type: 'message',
    message: text,
  }) as AiChatMessage

// Pins a 1000px transcript in a 400px viewport, so 600 is the live edge and anything below it
// reads as scrolled away.
function pinTranscript() {
  const transcript = document.querySelector<HTMLElement>('[aria-label="Conversation transcript"]')!
  expect(transcript).not.toBeNull()
  let top = 0
  Object.defineProperty(transcript, 'scrollHeight', { get: () => 1000, configurable: true })
  Object.defineProperty(transcript, 'clientHeight', { get: () => 400, configurable: true })
  Object.defineProperty(transcript, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = v
    },
    configurable: true,
  })
  return {
    setScrollTop(next: number) {
      top = next
    },
  }
}

const jumpPill = () =>
  [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Jump to latest') || button.textContent?.includes(' new'))

const settlePillEntrance = () =>
  act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 320)
    await promise
  })

describe('ChatInterface scroll affordances', () => {
  it('shows a jump pill with a missed count while scrolled away, and jumps on click', async () => {
    const server = makeOverseer()
    const chat = withChatApi(server, [openChat as AiChatMetadata])
    await renderChat(server.overseer, 1)
    const transcript = pinTranscript()

    // Scrolled away from an empty transcript: the pill (once its entrance delay passes) reads as
    // a plain jump, with no missed count.
    transcript.setScrollTop(100)
    await act(async () => {
      document.querySelector<HTMLElement>('[aria-label="Conversation transcript"]')!
        .dispatchEvent(new Event('scroll'))
    })
    await settlePillEntrance()
    expect(jumpPill()?.textContent).toContain('Jump to latest')

    // Rows that land below the fold are counted, not silently followed.
    chat.emitMessage(agentMessage(1, 'first'))
    chat.emitMessage(agentMessage(2, 'second'))
    expect(jumpPill()?.textContent).toContain('2 new')

    // The pill jumps back to the live edge and dismisses itself.
    scrollToCalls.length = 0
    await act(async () => {
      jumpPill()!.click()
    })
    expect(scrollToCalls.at(-1)).toBe(1000)
    expect(jumpPill()).toBeUndefined()

    testRoot.cleanup()
  })

  it('anchors a prompt sent mid-turn near the top instead of pinning it to the bottom', async () => {
    const server = makeOverseer()
    const chat = withChatApi(server, [openChat as AiChatMetadata])
    await renderChat(server.overseer, 1)
    pinTranscript()

    chat.emitMetadata({ ...openChat, activeAgent } as AiChatMetadata)
    scrollToCalls.length = 0
    chat.emitMessage(userMessage(1, 'steer'))

    // jsdom rects are zero, so the prompt row sits scrollTop (600, the live edge) into the
    // content: anchoring scrolls to 600 - 96 = 504, not to the bottom (1000).
    expect(scrollToCalls.at(-1)).toBe(504)
    expect(scrollToCalls).not.toContain(1000)

    // The anchored reader is off the live edge: the pill offers the way back.
    await settlePillEntrance()
    expect(jumpPill()).toBeDefined()

    testRoot.cleanup()
  })
})
