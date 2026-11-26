import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, candidateExists, detectPowerShell, inject, majorFromPath, ps51Text, ps7Text, resolveGuidance } from '../index.js'

function fakeCtx(order = 1010, hasPwsh = true) {
  const calls = []
  const orderLookups = []
  const effectLabels = []
  const toolLookups = []
  const sections = new Map()
  const disposers = []
  return {
    calls,
    orderLookups,
    effectLabels,
    toolLookups,
    sections,
    disposers,
    ctx: {
      systemPrompt: {
        getSectionOrder: (name) => {
          orderLookups.push(name)
          return name === 'TOOL_PWSH' ? order : undefined
        },
        section: (section) => {
          calls.push(section)
          sections.set(section.name, section)
          return () => sections.delete(section.name)
        },
      },
      tools: {
        get: (name, scope) => {
          toolLookups.push([name, scope])
          return name === 'pwsh' && hasPwsh ? {} : undefined
        },
      },
      effect: (fn, label) => {
        effectLabels.push(label)
        const dispose = fn()
        disposers.push(dispose)
        return dispose
      },
    },
  }
}

const emptyWindowsEnv = { ProgramFiles: 'Z:\\nope', SystemRoot: 'Z:\\nope', PATH: '' }

test('plugin declares the system prompt and tools service dependencies', () => {
  assert.deepEqual(inject, ['systemPrompt', 'tools'])
})

test('5.1 guidance is accurate in automatic and forced modes', () => {
  const text = ps51Text()
  assert.match(text, /Windows PowerShell 5\.1/)
  assert.match(text, /5\.1 syntax only/)
  assert.match(text, /5\.1 equivalents/)
  assert.match(text, /Execution policy defaults to Restricted/)
  assert.doesNotMatch(text, /automatic detection checks the default install location/)
  assert.doesNotMatch(text, /no PowerShell 7 detected/)
  assert.doesNotMatch(text, /Sandbox language mode/)
})

test('PowerShell 7 guidance announces modern syntax', () => {
  assert.match(ps7Text(), /PowerShell 7/)
  assert.match(ps7Text(), /\?\?/)
})

test('candidateExists accepts a real file and a symlink, rejects a plain directory', () => {
  const entry = (file, link) => ({ isFile: () => file, isSymbolicLink: () => link })
  assert.equal(candidateExists('x', { lstatSync: () => entry(true, false) }), true)
  assert.equal(candidateExists('x', { lstatSync: () => entry(false, true) }), true)
  assert.equal(candidateExists('x', { lstatSync: () => entry(false, false) }), false)
})

test('candidateExists treats an lstat error as absent', () => {
  const fs = {
    lstatSync: () => {
      const error = new Error('missing')
      error.code = 'ENOENT'
      throw error
    },
  }
  assert.equal(candidateExists('x', fs), false)
})

test('majorFromPath maps executable names to a major version', () => {
  assert.equal(majorFromPath('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 7)
  assert.equal(majorFromPath('pwsh'), 7)
  assert.equal(majorFromPath('C:\\Program Files\\PowerShell\\7-preview\\pwsh-preview.exe'), 7)
  assert.equal(majorFromPath('pwsh-preview'), 7)
  assert.equal(majorFromPath('C:\\Program Files\\PowerShell\\7\\pwsh.exe\\'), 7)
  assert.equal(majorFromPath('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 5)
  assert.equal(majorFromPath('C:\\custom\\my-pwsh-tool.exe'), 5)
})

test('pwshPath config selects guidance and powerShellVersion wins over pwshPath', () => {
  const noDetection = { ProgramFiles: 'Z:\\nope', SystemRoot: 'Z:\\nope', PATH: '' }
  assert.equal(resolveGuidance({ pwshPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }, noDetection, 'win32').major, 7)
  assert.equal(resolveGuidance({ pwshPath: 'C:\\Program Files\\PowerShell\\7-preview\\pwsh-preview.exe' }, noDetection, 'win32').major, 7)
  assert.equal(resolveGuidance({ pwshPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }, noDetection, 'win32').major, 5)
  assert.equal(resolveGuidance({ pwshPath: 'C:\\x\\pwsh.exe', powerShellVersion: 5 }, noDetection, 'win32').major, 5)
})

test('pwshPath is trimmed and a blank value falls back to automatic detection', (t) => {
  const noDetection = { ProgramFiles: 'Z:\\nope', SystemRoot: 'Z:\\nope', PATH: '' }
  assert.equal(resolveGuidance({ pwshPath: ' C:\\x\\pwsh-preview.exe ' }, noDetection, 'win32').major, 7)
  assert.equal(resolveGuidance({ pwshPath: '' }, noDetection, 'win32').major, 5)

  const root = mkdtempSync(join(tmpdir(), 'pwg-blank-path-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'PowerShell', '7'), { recursive: true })
  writeFileSync(join(root, 'PowerShell', '7', 'pwsh.exe'), '')
  const ps7Env = { ProgramFiles: root, SystemRoot: root, PATH: '' }

  assert.equal(resolveGuidance({ pwshPath: '' }, ps7Env, 'win32').major, 7)
  assert.equal(resolveGuidance({ pwshPath: '   ' }, ps7Env, 'win32').major, 7)
})

test('invalid pwshPath is rejected', () => {
  assert.throws(() => resolveGuidance({ pwshPath: 7 }, emptyWindowsEnv, 'win32'), /invalid pwshPath/)
  assert.throws(() => resolveGuidance({ pwshPath: {} }, emptyWindowsEnv, 'linux'), /invalid pwshPath/)
})

test('detection falls back to the Windows PowerShell 5.1 path when no pwsh.exe exists', () => {
  const result = detectPowerShell(emptyWindowsEnv, 'win32')
  assert.deepEqual(result, {
    major: 5,
    path: join(emptyWindowsEnv.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  })
})

test('detection reports PowerShell 7 from Program Files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pwg-program-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const executable = join(root, 'PowerShell', '7', 'pwsh.exe')
  mkdirSync(join(root, 'PowerShell', '7'), { recursive: true })
  writeFileSync(executable, '')

  assert.deepEqual(detectPowerShell({ ProgramFiles: root, SystemRoot: root, PATH: '' }, 'win32'), {
    major: 7,
    path: executable,
  })
})

test('detection normalizes quoted and empty PATH entries', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pwg-path-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const executable = join(dir, 'pwsh.exe')
  writeFileSync(executable, '')

  const result = detectPowerShell({
    ProgramFiles: emptyWindowsEnv.ProgramFiles,
    SystemRoot: emptyWindowsEnv.SystemRoot,
    PATH: `; "${dir}" ;`,
  }, 'win32')

  assert.deepEqual(result, { major: 7, path: executable })
})

test('Program Files takes priority over PATH', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pwg-priority-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const programFiles = join(root, 'program-files')
  const pathDir = join(root, 'path-bin')
  const programExecutable = join(programFiles, 'PowerShell', '7', 'pwsh.exe')
  mkdirSync(join(programFiles, 'PowerShell', '7'), { recursive: true })
  mkdirSync(pathDir)
  writeFileSync(programExecutable, '')
  writeFileSync(join(pathDir, 'pwsh.exe'), '')

  const result = detectPowerShell({ ProgramFiles: programFiles, SystemRoot: root, PATH: pathDir }, 'win32')

  assert.deepEqual(result, { major: 7, path: programExecutable })
})

test('PATH uses the first matching entry', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pwg-path-order-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = join(root, 'first')
  const second = join(root, 'second')
  const executable = join(first, 'pwsh.exe')
  mkdirSync(first)
  mkdirSync(second)
  writeFileSync(executable, '')
  writeFileSync(join(second, 'pwsh.exe'), '')

  const result = detectPowerShell({
    ProgramFiles: emptyWindowsEnv.ProgramFiles,
    SystemRoot: root,
    PATH: `${first};${second}`,
  }, 'win32')

  assert.deepEqual(result, { major: 7, path: executable })
})

test('a directory named pwsh.exe is not treated as PowerShell 7', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pwg-directory-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'PowerShell', '7', 'pwsh.exe'), { recursive: true })

  assert.equal(detectPowerShell({ ProgramFiles: root, SystemRoot: root, PATH: '' }, 'win32').major, 5)
})

test('detection accepts any lstat symlink, like upstream', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pwg-symlink-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const programFiles = join(root, 'program-files')
  const executable = join(programFiles, 'PowerShell', '7', 'pwsh.exe')
  const target = join(root, 'target.exe')
  const targetDirectory = join(root, 'target-directory')
  mkdirSync(join(programFiles, 'PowerShell', '7'), { recursive: true })
  mkdirSync(targetDirectory)
  writeFileSync(target, '')

  try {
    symlinkSync(target, executable)
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('symlink creation is not permitted on this host')
    throw error
  }

  assert.deepEqual(detectPowerShell({ ProgramFiles: programFiles, SystemRoot: root, PATH: '' }, 'win32'), {
    major: 7,
    path: executable,
  })

  // Upstream lstat accepts these too; the real failure is the spawn, not the detection.
  rmSync(executable)
  symlinkSync(join(root, 'missing.exe'), executable)
  assert.equal(detectPowerShell({ ProgramFiles: programFiles, SystemRoot: root, PATH: '' }, 'win32').major, 7)

  rmSync(executable)
  symlinkSync(targetDirectory, executable, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(detectPowerShell({ ProgramFiles: programFiles, SystemRoot: root, PATH: '' }, 'win32').major, 7)
})

test('non-Windows detection returns no PowerShell version or path', () => {
  assert.deepEqual(detectPowerShell({}, 'linux'), { major: 0, path: null })
})

test('automatic PowerShell 7 detection selects the matching guidance', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pwg-guidance-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'PowerShell', '7'), { recursive: true })
  writeFileSync(join(root, 'PowerShell', '7', 'pwsh.exe'), '')

  const guidance = resolveGuidance({}, { ProgramFiles: root, SystemRoot: root, PATH: '' }, 'win32')

  assert.equal(guidance.major, 7)
  assert.equal(guidance.text, ps7Text())
})

test('forced versions skip detection entirely', () => {
  const env = new Proxy({}, {
    get() {
      throw new Error('forced versions must not read the detection environment')
    },
  })

  assert.deepEqual(resolveGuidance({ powerShellVersion: 7 }, env, 'win32'), {
    major: 7,
    text: ps7Text(),
  })
  assert.deepEqual(resolveGuidance({ powerShellVersion: 5 }, env, 'win32'), {
    major: 5,
    text: ps51Text(),
  })
})

test('non-Windows hosts produce no guidance', () => {
  assert.equal(resolveGuidance({}, {}, 'linux'), null)
  assert.equal(resolveGuidance({}, {}, 'darwin'), null)
})

test('invalid powerShellVersion is rejected before platform no-op', () => {
  assert.throws(
    () => resolveGuidance({ powerShellVersion: '7' }, emptyWindowsEnv, 'win32'),
    /expected 5, 7, null, or omitted/,
  )
  assert.throws(
    () => resolveGuidance({ powerShellVersion: 8 }, emptyWindowsEnv, 'linux'),
    /invalid powerShellVersion/,
  )
})

test('null powerShellVersion keeps automatic detection', () => {
  assert.equal(resolveGuidance({ powerShellVersion: null }, emptyWindowsEnv, 'win32').major, 5)
})

test('apply registers and disposes one section after TOOL_PWSH', { skip: process.platform !== 'win32' }, () => {
  const { calls, orderLookups, effectLabels, toolLookups, sections, disposers, ctx } = fakeCtx(1010)
  apply(ctx, { powerShellVersion: 5 })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'guard:pwsh-windows-guard')
  assert.equal(calls[0].order, 1015)
  assert.equal(typeof calls[0].text, 'function')
  assert.equal(calls[0].interpolate, false)
  assert.deepEqual(orderLookups, ['TOOL_PWSH'])
  assert.deepEqual(effectLabels, ['pwsh-windows-guard.section()'])
  assert.deepEqual(toolLookups, [])
  assert.equal(sections.size, 1)

  assert.equal(calls[0].text({ scope: 'agent-a' }), ps51Text())
  assert.deepEqual(toolLookups, [['pwsh', 'agent-a']])

  disposers[0]()
  assert.equal(sections.size, 0)
})

test('apply renders nothing when the pwsh tool is absent from the agent scope', { skip: process.platform !== 'win32' }, () => {
  const { calls, toolLookups, sections, ctx } = fakeCtx(1010, false)
  apply(ctx, { powerShellVersion: 5 })

  assert.equal(sections.size, 1)
  assert.equal(calls[0].text({ scope: 'agent-without-shell' }), '')
  assert.deepEqual(toolLookups, [['pwsh', 'agent-without-shell']])
})

test('apply uses dynamic section order and the fixed fallback', { skip: process.platform !== 'win32' }, () => {
  const dynamic = fakeCtx(42)
  apply(dynamic.ctx, { powerShellVersion: 7 })
  assert.equal(dynamic.calls[0].order, 47)
  assert.equal(dynamic.calls[0].text({ scope: 'agent-a' }), ps7Text())

  const fallback = fakeCtx(Number.POSITIVE_INFINITY)
  apply(fallback.ctx, { powerShellVersion: 5 })
  assert.equal(fallback.calls[0].order, 1015)
})

test('apply is a no-op on non-Windows hosts', { skip: process.platform === 'win32' }, () => {
  const { calls, sections, disposers, ctx } = fakeCtx(1010)
  apply(ctx, {})

  assert.equal(calls.length, 0)
  assert.equal(sections.size, 0)
  assert.equal(disposers.length, 0)
})
