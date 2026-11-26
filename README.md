# dsh-pwsh-windows-guard

A **DeepSeek Harness (DSH)** host-only bundle that detects the machine's Windows PowerShell major version (7 or 5.1) and injects host-specific rules into the system prompt, so the agent stops tripping over the same PowerShell pitfalls.

> [简体中文说明](README.zh.md)

## What it does

- On **Windows PowerShell 5.1** hosts, adds concise rules the harness does not already provide:
  - no `??`, ternary `a ? b : c`, `&&` / `||` (they fail at parse time in 5.1);
  - a 5.1 parse error can print as mojibake (`����λ��`) — treat it as a syntax problem, not an external failure;
  - execution policy defaults to `Restricted`, so a `.ps1` file is usually blocked;
  - native commands do not throw on a non-zero exit — check `$LASTEXITCODE`.
- On **PowerShell 7** hosts, notes that modern syntax is available.
- On **non-Windows** hosts it does nothing (returns without injecting).
- The Windows sandbox language-mode and named-pipe EPERM notes are delivered by DSH's built-in `pwsh` tool description, so this plugin does **not** duplicate them — that keeps the per-request prompt smaller.

The plugin only shapes prompt text. It does **not** change how the `pwsh` tool executes, makes no network requests, collects no telemetry, and writes no files.

## Requirements

- DSH with the `ctx.systemPrompt` service. Tested against **DSH 0.2.2-rc.5**.
- Windows host (the plugin is a no-op elsewhere).
- The version detection mirrors `@deepseek-ai/dsh-pwsh-local` **0.2.2-rc.5**'s executable resolution order. If the `pwsh` executor is configured with an explicit `pwshPath`, the plugin does not follow it — use `powerShellVersion` to force the right guidance in that case.

## Install

### Local directory (development)

1. In DSH Desktop open **Plugins → Add plugin** and choose this directory.
2. Enable the bundle `dsh-pwsh-windows-guard` in your profile.
3. Restart DSH after changing `index.js` (module code is loaded at startup).

### From npm / git (once published)

Resolve the published package as a bundle dependency of your DSH profile, then enable it. The bundle row id is `pwsh-windows-guard`.

## Configuration

You can force a version in the bundle row's `config` (optional):

```yaml
config:
  powerShellVersion: 5   # or 7; omit / null to auto-detect
```

An invalid value (e.g. `"7"`, `8`) is rejected loudly at load time instead of silently falling back to auto-detection.

## Development

```sh
npm test
```

Tests use the built-in `node:test` runner and are dependency-free. The Windows-only path is covered by CI on `windows-latest`; the pure guidance/detection functions are tested on any OS.

## Limitations

- Only changes the prompt shown to the model — it does **not** change how the `pwsh` tool executes.
- Cannot make Windows PowerShell 5.1 understand PowerShell 7 syntax; install PowerShell 7 to unlock it (the tool auto-detects `C:\Program Files\PowerShell\7\pwsh.exe`).
- Version detection duplicates the upstream resolver rather than importing it (keeps the bundle dependency-free); see the pin notes above.

## License

[MIT](LICENSE)
