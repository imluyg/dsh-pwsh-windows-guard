// dsh-pwsh-windows-guard
// Host-only DSH bundle: detect the active Windows PowerShell major version and
// inject host-specific rules into the system prompt so the agent stops hitting
// the recurring Windows/PowerShell failure modes.
//
// Dependency-free by design: only Node built-ins, so it installs cleanly from a
// local directory or from npm without pulling in extra packages.
import { lstatSync } from 'node:fs'
import { join } from 'node:path'

export const inject = ['systemPrompt']

function exists(path) {
  try {
    const stat = lstatSync(path)
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
 * Non-Windows hosts return major 0 so callers can skip Windows-only guidance.
 * This deliberately does NOT observe the executor's own `pwshPath` override; if
 * that is configured to a different executable, set `powerShellVersion` instead.
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
    if (exists(candidate)) return { major: 7, path: candidate }
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
    'The `pwsh` tool runs **Windows PowerShell 5.1** on this machine (no PowerShell 7 detected). Write PowerShell, not bash — native Windows paths and `$env:NAME` variables. These rules prevent the failures that otherwise look like the AI "breaking PowerShell":',
    '',
    '- **5.1 syntax only.** `??`, the ternary `a ? b : c`, and the chain operators `&&` / `||` do not exist in 5.1 and fail at parse time — the whole command never runs. Use `if`/`else`, `;`, and separate statements instead.',
    '- **Check native exit codes yourself.** A native program (git, node, cmd, …) exiting non-zero does not throw. Inspect `$LASTEXITCODE` (or `$?`) before assuming success.',
    '- **Execution policy defaults to Restricted.** Running a `.ps1` file is usually blocked; keep code inline in `-Command`, or invoke `powershell -ExecutionPolicy Bypass -File` (a Group Policy can still override it).',
    '- **Treat garbled errors as syntax errors.** Normal output is UTF-8, but a 5.1 parse error can print as mojibake such as `����λ��`. When you see that, suspect an unsupported construct (`??`, `&&`, ternary) and rewrite in 5.1 syntax instead of blaming the command.',
    '',
    'Installing PowerShell 7 removes the syntax restriction; the tool auto-detects it at `C:\\Program Files\\PowerShell\\7\\pwsh.exe`.',
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
 * Validate configuration and choose the guidance text for this host.
 *
 * @param {{ powerShellVersion?: 5 | 7 | null }} config
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {{ major: number, text: string } | null} `null` when not Windows (no injection).
 * @throws when `powerShellVersion` is neither 5, 7, null, nor omitted.
 */
export function resolveGuidance(config = {}, env = process.env, platform = process.platform) {
  const forced = config.powerShellVersion
  if (forced !== undefined && forced !== null && forced !== 5 && forced !== 7) {
    throw new Error(
      `dsh-pwsh-windows-guard: invalid powerShellVersion ${JSON.stringify(forced)}; expected 5, 7, or omitted for auto-detect`,
    )
  }
  if (platform !== 'win32') return null
  const detected = detectPowerShell(env, platform)
  const major = forced === 5 || forced === 7 ? forced : detected.major
  return { major, text: major >= 7 ? ps7Text() : ps51Text() }
}

export function apply(ctx, config = {}) {
  const guidance = resolveGuidance(config)
  if (guidance === null) return

  // Place right after the built-in `tool:pwsh` section (order 1010), falling
  // back to a fixed offset if that name is ever removed from the order table.
  const toolPwshOrder = ctx.systemPrompt.getSectionOrder('TOOL_PWSH')
  const order = Number.isFinite(toolPwshOrder) ? toolPwshOrder + 5 : 1015

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'guard:pwsh-windows-guard',
    order,
    text: guidance.text,
    interpolate: false,
  }))
}
