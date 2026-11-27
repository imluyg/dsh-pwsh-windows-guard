# dsh-pwsh-windows-guard

A **DeepSeek Harness (DSH)** host-only bundle that detects the machine's Windows PowerShell major version (7 or 5.1) and injects host-specific rules into the system prompt, so the agent stops tripping over the same PowerShell pitfalls.

> [简体中文说明](README.zh.md)

## What it does

- On **Windows PowerShell 5.1** hosts, adds concise rules the harness does not already provide:
  - no `??`, ternary `a ? b : c`, `&&` / `||` (they fail at parse time in 5.1);
  - a 5.1 parse error can print as mojibake (`����λ��`) — treat it as a syntax problem, not an external failure;
  - execution policy defaults to `Restricted`, so a `.ps1` file is usually blocked;
  - `curl`/`wget` are aliases for `Invoke-WebRequest` (use `curl.exe`), and PS7-only parameters such as `-AsHashtable` or `-Parallel` are unknown in 5.1;
  - native commands do not throw on a non-zero exit — check `$LASTEXITCODE`.
- On **PowerShell 7** hosts, notes that modern syntax is available.
- The section is rendered lazily per agent and stays empty when that agent's preset does not mount the `pwsh` tool, so shell-less agents pay no prompt tokens.
- On **non-Windows** hosts it does nothing (returns without injecting).
- The Windows sandbox language-mode and named-pipe EPERM notes are delivered by DSH's built-in `pwsh` tool description, so this plugin does **not** duplicate them — that keeps the per-request prompt smaller.

The plugin only shapes prompt text. It does **not** change how the `pwsh` tool executes, makes no network requests, collects no telemetry, and writes no files.

## Requirements

- DSH with the `ctx.systemPrompt` and `ctx.tools` services. Tested against **DSH 0.2.2-rc.5**.
- Windows host (the plugin is a no-op elsewhere).
- The plugin reads the executor's resolved path from the `shell` service at render time (`ctx.get('shell').pwshPath`, exposed by `@deepseek-ai/dsh-pwsh-local` **0.2.2-rc.5** and inherited by the sandbox executor), so an executor-level `pwshPath` is followed automatically. Executors that do not expose `pwshPath` fall back to this plugin's `pwshPath`, then to automatic detection, which mirrors the same package's resolution order: the default `%ProgramFiles%\PowerShell\7\pwsh.exe`, then `pwsh.exe` entries on `PATH`, then Windows PowerShell 5.1.

## Install

### Local directory (development)

1. In DSH Desktop open **Plugins → Add plugin** and choose this directory.
2. Enable the bundle `dsh-pwsh-windows-guard` in your profile.
3. Restart DSH after changing `index.js` (module code is loaded at startup).

### From npm / git (once published)

Resolve the published package as a bundle dependency of your DSH profile, then enable it. The bundle row id is `pwsh-windows-guard`.

## Configuration

Override detection from the bundle row's `config` (optional):

```yaml
config:
  powerShellVersion: 5      # 5 or 7; omit / null to auto-detect
  pwshPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'   # optional; major version inferred from the name
```

`powerShellVersion` (`5` or `7`) wins over everything. Precedence: `powerShellVersion` > the executor's resolved `pwshPath` > this plugin's `pwshPath` > automatic detection. The plugin's `pwshPath` is a fallback for executors that do not expose one: the major version is inferred from the executable name (`pwsh.exe` / `pwsh-preview.exe` → 7, `powershell.exe` → 5), and a blank value is treated as unset. An executor executable with an unrecognized name is skipped rather than treated as 5.1. With none of these available, detection probes the default locations and `PATH`. Invalid values (e.g. `"7"`, `8`, or a non-string `pwshPath`) are rejected at load time on every platform, before the non-Windows no-op.

## Development

```sh
npm test
```

Tests use the built-in `node:test` runner and are dependency-free. CI runs the full suite on Windows and Linux with Node 18, 20, 22, and 24; Windows-only injection tests are skipped on non-Windows runners.

## Limitations

- Only changes the prompt shown to the model — it does **not** change how the `pwsh` tool executes.
- Cannot make Windows PowerShell 5.1 understand PowerShell 7 syntax; install PowerShell 7 to unlock it (automatic detection checks the default install location and `PATH` unless a version is forced).
- Version detection copies the upstream resolver rather than importing it (keeps the bundle dependency-free); the executor's `pwshPath` is preferred whenever the shell service exposes it. The `dsh-pwsh-sandbox` executor delegates to `@deepseek-ai/dsh-pwsh-local`, so mirroring `dsh-pwsh-local` remains the fallback's one definition that matters.
- Existence detection uses the same `lstat` rule as upstream: a real file or any symlink counts. A dangling link or a link to a directory therefore also reports PowerShell 7, since upstream picks it too and the spawn itself then fails.
- Executors that do not expose a `pwshPath` cannot be aligned automatically; set this plugin's `pwshPath` or `powerShellVersion`.

## License

[MIT](LICENSE)
