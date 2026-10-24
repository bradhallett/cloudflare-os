// Builds the frontend through the real production build twice — once with VITE_SAAS unset (the
// OSS build) and once with VITE_SAAS=true — and inspects the emitted assets. This is the
// compile-out contract of the SaaS gate: the OSS bundle must carry no SaaS strings at all (the
// gate folds away the shell's chunk), while the SaaS build ships that shell as its own chunk,
// imported lazily from another asset.

// @ts-expect-error node builtin without @types/node
import { execFile } from 'node:child_process'
// @ts-expect-error node builtin without @types/node
import process from 'node:process'
// @ts-expect-error node builtin without @types/node
import { readdirSync, readFileSync } from 'node:fs'
// @ts-expect-error node builtin without @types/node
import { join } from 'node:path'
// @ts-expect-error node builtin without @types/node
import { fileURLToPath } from 'node:url'
// @ts-expect-error node builtin without @types/node
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url))
const viteBin = join(packageRoot, 'node_modules', 'vite', 'bin', 'vite.js')
// Scratch under node_modules/.vite (vitest's own scratch area, see vitest.browser.config.ts): out
// of the source tree, so it is neither an input of the cached test task nor a working-copy stain.
const scratchRoot = join(packageRoot, 'node_modules', '.vite', 'saas-bundle-test')

/** JS asset file names and contents of a production build with VITE_SAAS set per `saas`. */
async function buildAssets(saas: boolean): Promise<{ names: string[]; sources: string[] }> {
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'production' }
  if (saas) env.VITE_SAAS = 'true'
  else delete env.VITE_SAAS // the OSS build must be built without it, whatever the shell has
  const outDir = join(scratchRoot, saas ? 'on' : 'off')
  await run(process.execPath, [viteBin, 'build', '--outDir', outDir], { cwd: packageRoot, env })
  const names = readdirSync(join(outDir, 'assets')).filter((name: string) => name.endsWith('.js'))
  return { names, sources: names.map((name: string) => readFileSync(join(outDir, 'assets', name), 'utf8')) }
}

/** SaaS surface strings: every surface's marker, the flag's name, the runtime channel's field. */
const SAAS_MARKERS =
    /saas-shell|VITE_SAAS|saasEnabled|saas-signup-funnel|saas-checkout-return|saas-org-settings|saas-upgrade-prompt|saas-org-switcher/

describe('SaaS build flag in the production bundle', () => {
  it(
    'carries no SaaS strings or chunks in the OSS build (VITE_SAAS unset)',
    async () => {
      const { names, sources } = await buildAssets(false)

      expect(names.filter((name) => /saas/i.test(name))).toEqual([])
      expect(sources.some((source) => SAAS_MARKERS.test(source))).toBe(false)
    },
    240_000,
  )

  it(
    'ships the shell as its own lazily-imported chunk in the SaaS build (VITE_SAAS=true)',
    async () => {
      const { names, sources } = await buildAssets(true)

      const shellChunks = names.filter((_name, i) => sources[i].includes('saas-shell'))
      expect(shellChunks.length).toBeGreaterThan(0)
      // The shell must be a separate chunk that another asset pulls in dynamically (the lazy
      // gate), not code merged into the entry — that separation is what lets the OSS build drop
      // it wholesale.
      const wiredAsDynamicImport = sources.some(
        (source, i) => !shellChunks.includes(names[i]) && shellChunks.some((chunk) => source.includes(chunk)),
      )
      expect(wiredAsDynamicImport).toBe(true)
    },
    240_000,
  )
})
