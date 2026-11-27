// dsh-pwsh-windows-guard
// Host-only DSH bundle: detect the active Windows PowerShell major version and
// inject host-specific rules into the system prompt so the agent stops hitting
// the recurring Windows/PowerShell failure modes.
//
// The executor's resolved `pwshPath` wins when the shell service exposes it;
// the resolver mirror below is the fallback for executors that do not.
//
// Dependency-free by design: only Node built-ins, so it installs cleanly from a
// local directory or from npm without pulling in extra packages.
import { lstatSync } from 'node:fs'
import { join } from 'node:path'

export const inject = ['systemPrompt', 'tools']

const POWERSHELL_7_EXECUTABLES = new Set(['pwsh', 'pwsh.exe', 'pwsh-preview', 'pwsh-preview.exe'])
const WINDOWS_POWERSHELL_EXECUTABLES = new Set(['powershell', 'powershell.exe'])

/**
 * Whether a candidate counts as available, using the same rule as the upstream
 * resolver: `lstat` and accept a real file or a symlink. A dangling link or a
 * link to a directory therefore also counts — upstream would pick it too and
 * let the spawn fail.
 *
 * @param {string} candidate
 * @param {{ lstatSync: Function }} [fs]
 * @returns {boolean}
 */
export function candidateExists(candidate, fs = { lstatSync }) {
  try {
    const stat = fs.lstatSync(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Resolve whether the `pwsh` tool will run PowerShell 7 or Windows PowerShell 5.1.
 *
 * Mirrors `@deepseek-ai/dsh-pwsh-local`'s `resolvePwshPath` order so the guidance
 * the agent sees matches the shell the tool actually spawns (pinned to that
 * package's 0.2.2-rc.5 release; keep in sync when it changes):
 *   %ProgramFiles%\PowerShell\7\pwsh.exe -> PATH pwsh.exe entries -> 5.1 powershell.exe
 *
 * Uses only `env.ProgramFiles`, exactly like upstream. Upstream does not probe
 * `ProgramW6432`, so neither do we: on a 64-bit process both are identical, and
 * on a 32-bit process upstream resolves to 5.1 / PATH, which we must match.
 *
 * Non-Windows hosts return major 0 so callers can skip Windows-only guidance.
 * An executor `pwshPath` override is mirrored by this plugin's own `pwshPath`
 * config (major version inferred from the executable name); `powerShellVersion`
 * forces 5 or 7 and wins over everything.
 *
 * @returns {{ major: number, path: string | null }}
 */
export function detectPowerShell(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return { major: 0, path: null }
  const programFiles = env.ProgramFiles || 'C:\\Program Files'
  const systemRoot = env.SystemRoot || 'C:\\Windows'
  const candidates = [join(programFiles, 'PowerShell', '7', 'pwsh.exe')]
  for (const entry of (env.PATH || '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length > 0) candidates.push(join(trimmed, 'pwsh.exe'))
  }
  for (const candidate of candidates) {
    if (candidateExists(candidate)) return { major: 7, path: candidate }
  }
  return { major: 5, path: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') }
}

/**
 * Host-specific guidance for Windows PowerShell 5.1.
 *
 * Only contains rules DSH does not already deliver: the sandbox language-mode
 * and named-pipe EPERM notes are part of the built-in `pwsh` tool description
 * (and are omitted there when no confining executor is mounted), so repeating
 * them here would just cost tokens on every request.
 */
export function ps51Text() {
  return [
    '## PowerShell on this Windows host',
    '',
    'The `pwsh` tool runs **Windows PowerShell 5.1** on this machine. Write PowerShell, not bash. These rules prevent the failures that otherwise look like the AI "breaking PowerShell":',
    '',
    '- **5.1 syntax only.** `??`, the ternary `a ? b : c`, and the chain operators `&&` / `||` do not exist in 5.1 and fail at parse time — the whole command never runs.',
    '- **5.1 equivalents.** `a && b` → `a; if ($?) { b }`; `a || b` → `a; if (-not $?) { b }`; `c ? x : y` → `if (c) { x } else { y }`; `$v ?? d` → `$x = if ($null -ne $v) { $v } else { $d }`.',
    '- **Check native exit codes yourself.** A native program (git, node, cmd, …) exiting non-zero does not throw. Inspect `$LASTEXITCODE` before assuming success.',
    '- **Execution policy defaults to Restricted.** Running a `.ps1` file is usually blocked; keep code inline in `-Command`, or invoke `powershell -ExecutionPolicy Bypass -File` (a Group Policy can still override it).',
    '- **`curl`/`wget` are not curl and wget.** In 5.1 they are aliases for `Invoke-WebRequest`; a bash-style `curl -s URL` fails before any request (`-Uri` is missing). Use `curl.exe` or `Invoke-RestMethod`.',
    '- **PS7-only parameters fail as unknown.** `ConvertFrom-Json -AsHashtable`, `ForEach-Object -Parallel`, `Join-Path -AdditionalChildPath`, `Test-Json`, and `-SkipCertificateCheck` do not exist in 5.1; if a parameter is rejected, assume it is unavailable and use a 5.1 equivalent.',
    '- **Treat garbled errors as syntax errors.** Normal output is UTF-8, but a 5.1 parse error can print as mojibake such as `����λ��`. When you see that, suspect an unsupported construct (`??`, `&&`, ternary) and rewrite in 5.1 syntax instead of blaming the command.',
  ].join('\n')
}

/** Guidance for hosts whose `pwsh` tool runs PowerShell 7. */
export function ps7Text() {
  return [
    '## PowerShell on this Windows host',
    '',
    'The `pwsh` tool runs **PowerShell 7** on this machine — modern syntax (`??`, ternary, `&&` / `||`) is available. Still write PowerShell (native Windows paths, `$env:NAME`), and check `$LASTEXITCODE` after native commands because a non-zero exit does not throw.',
  ].join('\n')
}

/**
 * @param {string} path
 * @returns {string}
 */
function executableName(path) {
  return String(path).trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop().toLowerCase()
}

/**
 * Infer the PowerShell major version from an explicit executable path, so a
 * configured `pwshPath` (the executor's override) yields matching guidance.
 * `powershell.exe` is Windows PowerShell 5.1; `pwsh`, `pwsh.exe`, and the
 * preview binaries `pwsh-preview` / `pwsh-preview.exe` are PowerShell 7.
 *
 * @param {string} path
 * @returns {5 | 7}
 */
export function majorFromPath(path) {
  return POWERSHELL_7_EXECUTABLES.has(executableName(path)) ? 7 : 5
}

/**
 * Infer the major version from the executor's resolved path, which is runtime
 * data rather than a trusted config value: an unrecognized name returns `null`
 * so a wrapper executable cannot silently downgrade guidance to 5.1.
 *
 * @param {unknown} path
 * @returns {5 | 7 | null}
 */
function executorMajor(path) {
  if (typeof path !== 'string') return null
  const name = executableName(path)
  if (POWERSHELL_7_EXECUTABLES.has(name)) return 7
  if (WINDOWS_POWERSHELL_EXECUTABLES.has(name)) return 5
  return null
}

/**
 * Validate configuration and choose the guidance text for this host.
 *
 * Precedence: forced `powerShellVersion` > the executor's resolved `pwshPath`
 * (`executorPath`) > this plugin's `pwshPath` > automatic detection.
 *
 * @param {{ powerShellVersion?: 5 | 7 | null, pwshPath?: string | null }} config
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @param {unknown} executorPath the path the shell service actually spawns; runtime value, non-strings are ignored
 * @returns {{ major: number, text: string } | null} `null` when not Windows (no injection).
 * @throws when `powerShellVersion` is neither 5, 7, null, nor omitted, or `pwshPath` is not a string.
 */
export function resolveGuidance(config = {}, env = process.env, platform = process.platform, executorPath = null) {
  const forced = config.powerShellVersion
  if (forced !== undefined && forced !== null && forced !== 5 && forced !== 7) {
    throw new Error(
      `dsh-pwsh-windows-guard: invalid powerShellVersion ${JSON.stringify(forced)}; expected 5, 7, null, or omitted for auto-detect`,
    )
  }
  const declared = config.pwshPath
  if (declared !== undefined && declared !== null && typeof declared !== 'string') {
    throw new Error(
      `dsh-pwsh-windows-guard: invalid pwshPath ${JSON.stringify(declared)}; expected a string, null, or omitted`,
    )
  }
  const declaredPath = typeof declared === 'string' ? declared.trim() : ''
  if (platform !== 'win32') return null
  const major =
    forced === 5 || forced === 7
      ? forced
      : executorMajor(executorPath) ??
        (declaredPath.length > 0 ? majorFromPath(declaredPath) : detectPowerShell(env, platform).major)
  return { major, text: major >= 7 ? ps7Text() : ps51Text() }
}

export function apply(ctx, config = {}) {
  const base = resolveGuidance(config)
  if (base === null) return

  // Place right after the built-in `tool:pwsh` section (order 1010), falling
  // back to a fixed offset if that name is ever removed from the order table.
  const toolPwshOrder = ctx.systemPrompt.getSectionOrder('TOOL_PWSH')
  const order = Number.isFinite(toolPwshOrder) ? toolPwshOrder + 5 : 1015

  const forced = config.powerShellVersion === 5 || config.powerShellVersion === 7
  const texts = { 5: ps51Text(), 7: ps7Text() }

  // The pwsh tool is mounted per agent preset, so only the assembling scope can
  // tell whether an agent actually has it; render nothing for agents without it.
  // The executor is read here rather than at apply time because the shell
  // service may not be loaded yet and its path follows config changes.
  const text = ({ scope }) => {
    if (ctx.tools.get('pwsh', scope) === undefined) return ''
    if (forced) return base.text
    let fromExecutor = null
    try {
      fromExecutor = executorMajor(ctx.get?.('shell')?.pwshPath)
    } catch {}
    return fromExecutor === null || fromExecutor === base.major ? base.text : texts[fromExecutor]
  }

  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'guard:pwsh-windows-guard',
      order,
      text,
      interpolate: false,
    }),
    'pwsh-windows-guard.section()',
  )
}
