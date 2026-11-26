import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, detectPowerShell, ps51Text, ps7Text, resolveGuidance } from '../index.js'

function fakeCtx(order = 1010) {
  const calls = []
  return {
    calls,
    ctx: {
      systemPrompt: {
        getSectionOrder: (name) => (name === 'TOOL_PWSH' ? order : undefined),
        section: (section) => {
          calls.push(section)
          return () => {}
        },
      },
      effect: (fn) => fn(),
    },
  }
}

const emptyWindowsEnv = { ProgramFiles: 'Z:\\nope', SystemRoot: 'Z:\\nope', PATH: '' }

test('5.1 guidance targets host-specific traps and does not duplicate the sandbox text', () => {
  const text = ps51Text()
  assert.match(text, /no PowerShell 7 detected/)
  assert.match(text, /5\.1 syntax only/)
  assert.match(text, /Execution policy defaults to Restricted/)
  assert.doesNotMatch(text, /Sandbox language mode/)
  assert.doesNotMatch(text, /PowerShell 7 is not installed/)
})

test('PowerShell 7 guidance announces modern syntax', () => {
  assert.match(ps7Text(), /PowerShell 7/)
  assert.match(ps7Text(), /\?\?/)
})

test('detection falls back to 5.1 when no pwsh.exe exists on Windows', () => {
  const result = detectPowerShell(emptyWindowsEnv, 'win32')
  assert.equal(result.major, 5)
})

test('detection reports PowerShell 7 when Program Files\\PowerShell\\7\\pwsh.exe exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'pwg-'))
  try {
    mkdirSync(join(root, 'PowerShell', '7'), { recursive: true })
    writeFileSync(join(root, 'PowerShell', '7', 'pwsh.exe'), '')
    const result = detectPowerShell({ ProgramFiles: root, SystemRoot: root, PATH: '' }, 'win32')
    assert.equal(result.major, 7)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detection reports PowerShell 7 when a PATH entry holds pwsh.exe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pwg-bin-'))
  try {
    writeFileSync(join(dir, 'pwsh.exe'), '')
    const result = detectPowerShell({ ProgramFiles: 'Z:\\nope', SystemRoot: 'Z:\\nope', PATH: dir }, 'win32')
    assert.equal(result.major, 7)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('non-Windows hosts produce no guidance', () => {
  assert.equal(resolveGuidance({}, {}, 'linux'), null)
  assert.equal(resolveGuidance({}, {}, 'darwin'), null)
})

test('invalid powerShellVersion is rejected loudly', () => {
  assert.throws(() => resolveGuidance({ powerShellVersion: '7' }, emptyWindowsEnv, 'win32'), /invalid powerShellVersion/)
  assert.throws(() => resolveGuidance({ powerShellVersion: 8 }, emptyWindowsEnv, 'win32'), /invalid powerShellVersion/)
})

test('forced version overrides detection', () => {
  assert.equal(resolveGuidance({ powerShellVersion: 7 }, emptyWindowsEnv, 'win32').major, 7)
  assert.equal(resolveGuidance({ powerShellVersion: 5 }, emptyWindowsEnv, 'win32').major, 5)
  assert.equal(resolveGuidance({ powerShellVersion: null }, emptyWindowsEnv, 'win32').major, 5)
})

test('apply registers one section right after TOOL_PWSH', { skip: process.platform !== 'win32' }, () => {
  const { calls, ctx } = fakeCtx(1010)
  apply(ctx, {})
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'guard:pwsh-windows-guard')
  assert.equal(calls[0].order, 1015)
  assert.equal(calls[0].interpolate, false)
})

test('apply is a no-op on non-Windows hosts', { skip: process.platform === 'win32' }, () => {
  const { calls, ctx } = fakeCtx(1010)
  apply(ctx, {})
  assert.equal(calls.length, 0)
})
