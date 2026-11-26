# dsh-pwsh-windows-guard

一个 **DeepSeek Harness (DSH)** Host-only 插件：自动探测本机 Windows PowerShell 主版本（7 或 5.1），并把本机专属的硬规则注入系统提示，让代理不再反复踩 PowerShell 的坑。

[English](README.md)

## 注入什么

- 检测到 **Windows PowerShell 5.1** 时，注入内置提示没有覆盖的本机规则：
  - 5.1 不支持 `??`、三元 `a ? b : c`、`&&` / `||`（写了整段解析失败）；
  - 5.1 的解析错误中文会乱码（`����λ��`）——当语法问题处理，别当成外部故障；
  - 执行策略默认 `Restricted`，直接跑 `.ps1` 通常被拒；
  - 原生命令非零退出不会抛异常，必须先看 `$LASTEXITCODE`。
- 检测到 **PowerShell 7** 时，提示现代语法可用。
- **非 Windows** 主机不做任何注入（直接返回，不注册提示段）。
- Windows 沙箱的语言模式（`ConstrainedLanguage`）与管道 EPERM 边界说明由内置 `pwsh` 工具描述负责下发，本插件**不再重复**，以减小每轮提示体积。

本插件只改"给模型的提示"，**不改变 `pwsh` 工具的实际执行方式**；无网络请求、无遥测、不写文件。

## 要求

- 带 `ctx.systemPrompt` 服务的 DSH，在 **0.2.2-rc.5** 上验证。
- Windows 主机（其它平台为 no-op）。
- 版本探测复制了 `@deepseek-ai/dsh-pwsh-local` **0.2.2-rc.5** 的可执行文件解析顺序：先检查默认 `%ProgramFiles%\PowerShell\7\pwsh.exe`，再检查 `PATH` 中的 `pwsh.exe`，最后回退到 Windows PowerShell 5.1。若 `pwsh` 执行器用 `pwshPath` 强制指定了别的可执行文件，本插件不自动读取——请用本插件的 `pwshPath` 配置（或 `powerShellVersion`）对齐。

## 安装

### 本地目录（开发）

1. DSH Desktop 打开 **Plugins → Add plugin**，选择本目录。
2. 在 profile 里启用 bundle `dsh-pwsh-windows-guard`。
3. 改动 `index.js` 后需重启 DSH（模块代码在启动时加载）。

### 从 npm / git（发布后）

把已发布的包作为 bundle 依赖解析进 DSH profile，再启用即可。bundle 行 id 为 `pwsh-windows-guard`。

## 配置

可用 bundle 行的 `config` 覆盖探测（可选）：

```yaml
config:
  powerShellVersion: 5      # 5 或 7；省略 / null 则自动探测
  pwshPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'   # 可选；按文件名推断主版本
```

`powerShellVersion`（`5` 或 `7`）优先级最高。`pwshPath` 用于对齐执行器级的 `pwshPath` 覆盖：按可执行文件名推断主版本（`pwsh.exe` / `pwsh-preview.exe` → 7，`powershell.exe` → 5），空白值视为未设置。两者都不设时，探测默认安装位置与 `PATH`。非法值（如 `"7"`、`8`，或非字符串的 `pwshPath`）会在所有平台的加载阶段直接报错，先于非 Windows no-op 判断。

## 开发

```sh
npm test
```

测试用内置 `node:test`，零依赖。CI 在 Windows 与 Linux 上分别使用 Node 18、20、22、24 运行完整测试；非 Windows runner 会跳过仅 Windows 的注入测试。

## 限制

- 只改提示，不改变工具执行方式；
- 无法让 5.1 理解 PS7 专属语法，要彻底解锁需安装 PowerShell 7（自动探测会检查默认安装位置和 `PATH`，强制版本时除外）；
- 版本探测复制上游解析逻辑而非直接 import（保持 bundle 零依赖）。`dsh-pwsh-sandbox` 执行器委托给 `@deepseek-ai/dsh-pwsh-local`，所以对齐 `dsh-pwsh-local` 就是唯一需要对齐的定义；
- 存在性判定与上游相同的 `lstat` 规则：真实文件或任意符号链接都算存在。因此失效链接、指向目录的链接也会报 PowerShell 7——上游同样会选中它们，真正的失败发生在 spawn 阶段；
- 执行器级的 `pwshPath` 不会被自动读取；请用本插件的 `pwshPath` 配置对齐（或强制 `powerShellVersion`）。

## 许可证

[MIT](LICENSE)
