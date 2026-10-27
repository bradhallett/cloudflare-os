// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// The chat's plan-enforcement surfaces: an error message carrying `usage_limit` or a plan
// refusal code (what the backend attaches when the usage checker or a model/connector/workspace
// gate refuses) opens the SaaS upgrade prompt instead of the OSS build's out-of-credits modal,
// with the headline picked by the code. The suite re-imports ChatInterface under a stubbed
// VITE_SAAS so the commerce gate is baked on, exactly as a VITE_SAAS=true build does; the rest
// of the harness mirrors ChatInterface.actions.test.tsx.

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AiChatMessage, AiChatSubscriber, AiChatMetadata, Overseer } from '@gadgets/workshop-shared/api'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
// jsdom lays out nothing, so the log pane's scroll-into-view would throw.
Element.prototype.scrollTo = () => {}

const addToast = vi.hoisted(() => vi.fn<(toast: unknown) => void>())

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const Pass = ({ children }: { children?: React.ReactNode }) => children ?? null
  // Open-gated: the upgrade prompt's dialog must render its content so the test can see it,
  // while every other dialog stays unopened (children dropped).
  const Dialog = Object.assign(Pass, {
    Root: ({ children, open }: { children?: React.ReactNode, open?: boolean }) =>
      open ? <>{children}</> : null,
    Title: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
  })
  return {
    ...actual,
    Dialog,
    useKumoToastManager: () => ({ add: addToast }),
  }
})

vi.mock('../../../AuthContext', () => {
  const context = {
    authenticatedApi: {
      listGatekeeperVendors: async () => [],
      listBots: async () => [],
      // The upgrade prompt asks whoami for an admin-able org on open; none here.
      whoami: async () => ({ orgs: [] }),
    },
    currentUser: null,
  }
  return {
    useAuthenticatedApi: () => context,
    useOptionalAuthenticatedApi: () => null,
  }
})

// The upgrade prompt navigates on its primary action; ChatInterface itself has no router use.
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn<() => void>() }))

import { makeTestRoot } from '../../../action-test-harness'

const testRoot = makeTestRoot()
// The chat store registry is module-global and keyed by workspace id, so each mount takes a
// fresh id to keep tests' chats isolated from each other.
let mountSeq = 0

afterEach(() => {
  testRoot.cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.resetModules()
})

function withChatApi(overseer: RpcStub<Overseer>) {
  let subscriber: AiChatSubscriber | undefined
  Object.assign(overseer as object, {
    getChatMessage: vi.fn<() => Promise<null>>(async () => null),
    getChatHistory: async () => ({ messages: [] }),
    listChats: async () => [] as AiChatMetadata[],
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
  }
}

async function renderChat() {
  // Re-imported per test so the VITE_SAAS stub is baked into the commerce gate.
  vi.stubEnv('VITE_SAAS', 'true')
  vi.resetModules()
  const { default: ChatInterface } = await import('../ChatInterface')

  const overseer = {
    subscribeToActions: () => Promise.resolve({ [Symbol.dispose]: () => {} }),
    listActions: () => new Promise(() => {}),
    [Symbol.dispose]: () => {},
  } as unknown as RpcStub<Overseer>
  const chat = withChatApi(overseer)

  await testRoot.render(
    <ChatInterface
      workspaceId={`ChatInterface-refusalPrompt-${++mountSeq}`}
      overseer={overseer}
      restricted={false}
      selectedChatId={1}
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
  return chat
}

function errorMessage(code: string): AiChatMessage {
  return {
    chatId: 1,
    sequence: 0,
    timestamp: new Date(),
    author: { type: 'agent', id: 'model', name: 'Model' },
    type: 'error',
    message: 'The run failed.',
    code,
  } as AiChatMessage
}

describe('a plan-enforcement error opens the upgrade prompt', () => {
  it('a usage_limit error shows the usage-limit headline', async () => {
    const chat = await renderChat()
    await act(async () => { await Promise.resolve() })

    chat.emitMessage(errorMessage('usage_limit'))

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="saas-upgrade-prompt"]')).not.toBeNull()
      expect(document.body.textContent).toContain("You've reached your plan's usage limit")
    })
  })

  it('a plan-refusal code shows that refusal\'s headline', async () => {
    const chat = await renderChat()
    await act(async () => { await Promise.resolve() })

    chat.emitMessage(errorMessage('MODEL_NOT_ON_PLAN'))

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="saas-upgrade-prompt"]')).not.toBeNull()
      expect(document.body.textContent).toContain("That model isn't available on your plan")
    })
  })
})
