// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GadgetMetadata,
  GadgetSummary,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'

// Pins the key={id} remount: navigating to another workspace must reset the title draft, so a
// draft begun on workspace A can never be saved onto workspace B. Everything the editor composes
// is stubbed down to the callbacks that drive its layout (same harness as blueprintUpdate).

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const GADGET: GadgetSummary = { id: 1, type: 'gadget', title: 'Itinerary', commitId: 'head' }

const mocks = vi.hoisted(() => {
  const disposable = { [Symbol.dispose]() {} }
  return {
    params: { id: 'workspace-a' } as { id?: string },
    navigate: vi.fn<(options: {
      search: (prev: Record<string, unknown>) => unknown
      replace?: boolean
    }) => void>(),
    search: {} as Record<string, unknown>,
    mounts: [] as string[],
    workspace: {
      overseer: {
        stub: {
          subscribeToWorkpieces: async (subscriber: WorkpiecesSubscriber) => {
            await subscriber.entry(GADGET)
            await subscriber.ready()
            return disposable
          },
          // Surfaces the workspace's chat store opens with (see useChatStoreConnection).
          listChats: async () => [],
          listModels: async () => [],
          subscribeToChat: () => disposable,
          onRpcBroken: () => {},
          getGadget: () => disposable,
          listHooks: async () => [],
          subscribeToConsoleLogs: async () => disposable,
        },
      },
      metadata: { id: 'workspace-a', title: 'Trips', role: 'build' } as unknown as GadgetMetadata,
      error: null,
      connectionLost: false,
      observerConfig: null,
      retry: () => {},
      cancelObserverConfig: () => {},
      updateTitle: () => {},
    },
    authenticatedApi: {
      whoami: async () => ({ type: 'user', id: 'dev', name: 'Dev' }),
      listGadgets: async () => [],
    },
  }
})

vi.mock('@tanstack/react-router', () => ({
  useParams: () => mocks.params,
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.search,
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))

vi.mock('@cloudflare/kumo', () => {
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, onClick, disabled }: {
        children: ReactNode
        onClick?: () => void
        disabled?: boolean
      }) => <button type="button" role="menuitem" onClick={onClick} disabled={disabled}>{children}</button>,
      Separator: () => <hr />,
    },
  )
  return { DropdownMenu, useKumoToastManager: () => ({ add: () => {} }) }
})

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi }),
}))
vi.mock('./RpcContext', () => ({ useConnectionLost: () => false, useRpcStub: () => ({}) }))
vi.mock('./useWorkspaceOpen', () => ({ useWorkspaceOpen: () => mocks.workspace }))
vi.mock('./useActions', () => ({
  useActions: () => ({ pending: [] }),
  useActionEntries: () => {},
  actionLogResumed: () => true,
}))
vi.mock('./errorReporting', () => ({ reportIssue: () => {} }))
vi.mock('./features/blueprint-updates/useBlueprintUpdateAvailable', () => ({
  useBlueprintUpdateAvailable: () => false,
}))

// The two children whose reports decide when the editor's layout is ready. The chat mock counts
// mounts — it must climb to 2 when navigation remounts the workspace body — and mounts the
// workspace's real chat-store connection, since the editor reads its list-level state (chat
// count, chat 0) from the store instead of child callbacks.
vi.mock('./features/chat/ChatInterface', async () => {
  const { useChatStoreConnection } = await import('./features/chat/store/useChatStore')
  return {
    default: ({ workspaceId, overseer }: { workspaceId: string, overseer: never }) => {
      useEffect(() => { mocks.mounts.push('chat') }, [])
      useChatStoreConnection({
        workspaceId,
        overseer,
        selectedChatId: null,
        toasts: { add: () => '' } as never,
        onNavigateToChat: () => {},
      })
      return <div>chat pane</div>
    },
  }
})
vi.mock('./features/code/WorkpieceCodeInterface', () => ({
  default: ({ onHasCodeChange }: { onHasCodeChange: (hasCode: boolean) => void }) => {
    useEffect(() => { onHasCodeChange(true) }, [onHasCodeChange])
    return null
  },
}))

vi.mock('./features/blueprint-updates/UpdateFromBlueprintDialog', () => ({
  UpdateFromBlueprintDialog: () => null,
}))

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }: ComponentProps<'button'> & { tone?: string }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, danger: _danger, ...props }: ComponentProps<'button'> & { danger?: string }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopInput: (props: ComponentProps<'input'>) => <input {...props} />,
}))

vi.mock('./WorkpiecePicker', () => ({
  default: () => null,
  WORKPIECE_RAIL_COLLAPSED_WIDTH: 48,
  WORKPIECE_RAIL_EXPANDED_WIDTH: 220,
}))
vi.mock('./components/format/FormatVisuals', () => ({ FormatGlyph: () => null }))
vi.mock('./components/GadgetPresence', () => ({ GadgetPresence: () => null }))
vi.mock('./Activity', () => ({ default: () => null }))
vi.mock('./ActivityNotifications', () => ({ default: () => null }))
vi.mock('./BlueprintModal', () => ({ default: () => null }))
vi.mock('./Connections', () => ({ default: () => null }))
vi.mock('./GadgetExportMenu', () => ({ default: () => null }))
vi.mock('./GadgetUI', () => ({ default: () => null }))
vi.mock('./GadgetUseView', () => ({ default: () => null }))
vi.mock('./ObserverConfigModal', () => ({ default: () => null }))
vi.mock('./ShareModal', () => ({ default: () => null }))
vi.mock('./TopBarNotice', () => ({ default: () => null }))
vi.mock('./components/DeleteConfirmationDialog', () => ({ default: () => null }))
vi.mock('./components/ReconnectingChip', () => ({ default: () => null }))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))
vi.mock('./components/UserMenu', () => ({ default: () => null }))
vi.mock('./components/WorkspaceOpenErrorPage', () => ({ default: () => null }))
vi.mock('./features/notifications/WorkspaceNotificationsMenu', () => ({ WorkspaceNotificationsMenu: () => null }))

import GadgetEditor from './GadgetEditor'

let container: HTMLDivElement
let root: Root
const previousMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')

/** Renders the editor on a desktop screen. */
async function openEditor() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false }),
  })
  await act(async () => { root.render(<GadgetEditor />) })
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')]
    .find(candidate => candidate.getAttribute('aria-label') === name
      || candidate.textContent === name)
  if (!found) throw new Error(`No "${name}" button in: ${container.textContent}`)
  return found
}

beforeEach(() => {
  mocks.params = { id: 'workspace-a' }
  mocks.workspace.metadata = { id: 'workspace-a', title: 'Trips', role: 'build' } as unknown as GadgetMetadata
  mocks.navigate.mockReset()
  mocks.search = {}
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

/** Types into React's controlled input via the native setter, so state actually updates. */
function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  if (previousMatchMedia) Object.defineProperty(window, 'matchMedia', previousMatchMedia)
  else Reflect.deleteProperty(window, 'matchMedia')
})

describe('GadgetEditor title draft across workspaces', () => {
  it('drops the draft when navigating to another workspace (key={id} remount)', async () => {
    await openEditor()

    // Start editing workspace A's title and leave an unsaved draft in the input.
    await act(async () => { button('Rename workspace').click() })
    const input = container.querySelector('input[type="text"]') as HTMLInputElement
    expect(input).toBeTruthy()
    await act(async () => { type(input, 'Draft for A') })
    // Navigate to workspace B: same route, only the id param changes.
    mocks.params = { id: 'workspace-b' }
    mocks.workspace.metadata = { id: 'workspace-b', title: 'Journal', role: 'build' } as unknown as GadgetMetadata
    await act(async () => { root.render(<GadgetEditor />) })

    // The remount ended the edit session; B shows its own title, and no draft input survives.
    expect(container.querySelector('input[type="text"]')).toBeNull()
    expect(container.textContent).toContain('Journal')
    expect(container.textContent).not.toContain('Draft for A')
  })

  it('keeps the draft while staying on the same workspace', async () => {
    await openEditor()

    await act(async () => { button('Rename workspace').click() })
    const input = container.querySelector('input[type="text"]') as HTMLInputElement
    await act(async () => { type(input, 'Draft for A') })

    // An unrelated re-render (e.g. a toast or subscription tick) must not discard the draft.
    await act(async () => { root.render(<GadgetEditor />) })

    const still = container.querySelector('input[type="text"]') as HTMLInputElement
    expect(still).toBeTruthy()
    expect(still.value).toBe('Draft for A')
  })
})
