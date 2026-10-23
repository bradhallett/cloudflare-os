// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// The runtime half of the SaaS channel: unlike the compile-time VITE_SAAS flag, `useSaasEnabled()`
// reports what the server resolved for this deployment, so a SaaS build can also learn the mode at
// runtime. Null config (still loading) reads as off, matching the other ServerConfig conveniences.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { ServerConfig } from '@gadgets/workshop-shared/api'

import { ServerConfigContext, useSaasEnabled } from './ServerConfigContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Renders a probe that records what `useSaasEnabled()` observed under `config`. */
async function observed(config: ServerConfig | null): Promise<boolean[]> {
  const seen: boolean[] = []
  const Probe = () => {
    seen.push(useSaasEnabled())
    return null
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <ServerConfigContext.Provider value={config}>
        <Probe />
      </ServerConfigContext.Provider>,
    )
  })
  act(() => root.unmount())
  container.remove()
  return seen
}

/** A config carrying only what these tests vary; the rest of the shape is irrelevant to the hook. */
const configWith = (saasEnabled: boolean) => ({ saasEnabled }) as ServerConfig

describe('useSaasEnabled', () => {
  it('reads false while the server config is still loading (null)', async () => {
    expect(await observed(null)).toEqual([false])
  })

  it('reads the server-resolved SaaS mode', async () => {
    expect(await observed(configWith(true))).toEqual([true])
    expect(await observed(configWith(false))).toEqual([false])
  })
})
