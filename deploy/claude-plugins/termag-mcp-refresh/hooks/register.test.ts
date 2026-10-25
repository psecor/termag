import type { TestBody } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

// The test environment has it; the hooks module's typings name no timers.
declare const setTimeout: (fn: () => void, ms: number) => unknown

// Run with `claude plugin test deploy/claude-plugins/termag-mcp-refresh`. Each
// answer to clock.every below is one tick of the mod's poll. A change reloads
// on the first tick that reads the same version again.
type Answer = { text?: string } | Error
function engine(on: Parameters<TestBody>[1], file: { version: string | null }, answer: () => Answer = () => ({})) {
  const reloads: unknown[] = []
  const reads: unknown[] = []
  let tick: (() => void) | null = null
  let timers = 0
  on('fs.read', (_, e) => {
    reads.push(e)
    if (file.version === null) throw new Error('ENOENT')
    return { value: file.version }
  })
  on('command.run', (_, e) => {
    reloads.push(e)
    const a = answer()
    if (a instanceof Error) throw a
    return a
  })
  on('clock.every', () => { timers++; return new Promise(resolve => { tick = () => resolve({ value: undefined }) }) })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return {
    reloads,
    reads,
    get timers() { return timers },
    async tick() {
      const t = tick
      tick = null
      t?.()
      await new Promise<void>(r => setTimeout(r, 20))
    },
    get polling() { return tick !== null },
  }
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

test('reloads plugins once the version changes and holds still, and not again until it changes', async ($, on) => {
  const file = { version: '1' as string | null }
  const eng = engine(on, file)
  await $.session.start(START)
  await eng.tick()
  await eng.tick()
  expect(eng.reloads.length).toBe(0)
  file.version = '2'
  await eng.tick()
  expect(eng.reloads.length).toBe(0)
  await eng.tick()
  await eng.tick()
  expect(eng.reloads.length).toBe(1)
  expect(eng.reloads[0]).toMatchObject({ command: 'reload-plugins' })
  file.version = '3'
  await eng.tick()
  await eng.tick()
  expect(eng.reloads.length).toBe(2)
})

test('a burst of version changes reloads once', async ($, on) => {
  const file = { version: '1' as string | null }
  const eng = engine(on, file)
  await $.session.start(START)
  for (const v of ['2', '3', '4', '5']) {
    file.version = v
    await eng.tick()
  }
  expect(eng.reloads.length).toBe(0)
  await eng.tick()
  await eng.tick()
  expect(eng.reloads.length).toBe(1)
})

test('a change that goes back before it settles is no change', async ($, on) => {
  const file = { version: '1' as string | null }
  const eng = engine(on, file)
  await $.session.start(START)
  file.version = '2'
  await eng.tick()
  file.version = '1'
  await eng.tick()
  await eng.tick()
  expect(eng.reloads.length).toBe(0)
})

test('reads the version file the installer named', async ($, on) => {
  const eng = engine(on, { version: '1' })
  await $.session.start(START)
  // Uninstalled, the placeholder is relative to the mod's folder; termag-reconcile
  // replaces it with the absolute path of termag-credentials' version file.
  expect(String((eng.reads[0] as { path: string }).path).endsWith('/@TERMAG_MCP_VERSION_FILE@')).toBe(true)
})

test('a missing version file is no change, and its first appearance reloads', async ($, on) => {
  const file = { version: null as string | null }
  const eng = engine(on, file)
  await $.session.start(START)
  await eng.tick()
  expect(eng.reloads.length).toBe(0)
  file.version = '1'
  await eng.tick()
  await eng.tick()
  expect(eng.reloads.length).toBe(1)
})

test('a session without a person at the prompt (-p, the SDK, the chat runner) never polls or reloads', async ($, on) => {
  const file = { version: '1' as string | null }
  const eng = engine(on, file)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  expect(eng.timers).toBe(0)
  expect(eng.reads.length).toBe(0)
  expect(eng.reloads.length).toBe(0)
})

test('a reload that fails is not retried, and the next change tries again', async ($, on) => {
  const file = { version: '1' as string | null }
  const eng = engine(on, file, () => new Error('refused'))
  await $.session.start(START)
  file.version = '2'
  await eng.tick()
  await eng.tick()
  expect(eng.reloads.length).toBe(1)
  await eng.tick()
  await eng.tick()
  expect(eng.reloads.length).toBe(1)
  expect(eng.polling).toBe(true)
  file.version = '3'
  await eng.tick()
  await eng.tick()
  expect(eng.reloads.length).toBe(2)
})

test('a session that refuses the reload stops polling', async ($, on) => {
  const file = { version: '1' as string | null }
  const eng = engine(on, file, () => ({ text: "/reload-plugins isn't available over a remote connection in this session." }))
  await $.session.start(START)
  file.version = '2'
  await eng.tick()
  await eng.tick()
  expect(eng.reloads.length).toBe(1)
  file.version = '3'
  await eng.tick()
  await eng.tick()
  await eng.tick()
  expect(eng.reloads.length).toBe(1)
})
