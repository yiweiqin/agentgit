# 安装与自动跨窗口检查

## 安装

需要 Node 22.19+、Git，以及支持本地插件、钩子和跨聊天工具的 Codex 桌面端。
自动唤醒还需要本机 Codex CLI 的 `queue` 子命令，Codex 应保持运行并已登录。

```sh
git clone https://github.com/yiweiqin/agentgit.git
cd agentgit
npm ci
node packages/cli/bin/agentgit.mjs install
codex plugin add agentgit@personal
node packages/cli/bin/agentgit.mjs doctor
```

若安装器输出的 marketplace 名称不是 `personal`，使用它输出的安装命令。
安装器会生成适合本机的 Node、源码、钩子和 MCP 路径。保留检出目录，插件运行时会使用它。
安装后在 Codex 中批准钩子信任，再开始新会话。这不是 npm 发布包，不要使用 `npx agentgit`。

## 首次启用

在尚未启用的工作区开始会话，插件询问是否启用、创建专用协调窗口，并允许它通知同一工作区
的相关聊天检查冲突和接口变化。同意后，当前聊天执行
[setup.md](../plugins/agentgit/skills/agentgit/references/setup.md)：

1. 检查工具能力、原生 Codex 可执行文件和项目目录。
2. 预留初始化流程，防止同时创建两个协调窗口。
3. 创建并置顶 `AgenticGit — <工作区名>`，立即记录聊天 ID，以便中断恢复。
4. 配置自动检查、启动守护进程，验证健康接口和启用状态。
5. 通知协调窗口开始扫描；以后有可处理变化时由守护进程唤醒。

当前宿主没有“打开或选中文件夹”的钩子事件，**仅选中文件夹不能立即弹出提示**；实际入口是
开始会话或提交用户消息。普通文件夹可用，提交图需要 Git。若目录尚未成为 Codex 项目，
需先添加项目。宿主缺少跨聊天工具或 `queue` 时会明确报告限制。

拒绝后不创建聊天，也不向未启用目录写入 `.agentgit`；决定记在 `~/.agentgit/offers.json`。
忽略的提议有七天冷却时间，明确拒绝不会定期重问。

## 运行链路

会话启动、用户提交消息、准备修改争用文件时，已信任的钩子注入共享裁决。守护进程观察
账本和接口变化，把检查写入 `.agentgit/state/checks.json`，用官方 `codex queue` 唤醒协调窗口。
协调窗口遵守 [coordinate.md](../plugins/agentgit/skills/agentgit/references/coordinate.md)，
验证目标工作区、预留检查、发送消息、等待带检查编号的真实回复，再保存回执并汇总。

正常过程是 `pending → reserved → sent → replied`；失败、超时和问题消失分别记录为
`failed`、`timed_out`、`cancelled`。同一未消失问题不会重复创建检查。预留后十分钟无核验回复
则超时，不盲目重发；迟到的真实回复仍可登记。协调窗口自身唤醒失败最多重试三次。
收到回复只表示对方回答了，异议和“与我无关”同样保留，不等于冲突已修复。

无钩子信任时，会话历史导入只能观察已经发生的修改，不能提供写前保护。插件不能自行绕过
Codex 的信任确认。裁决是建议，不会强制拦截写入。自动检查不会自动合并、重置历史或修改
业务代码，也不会向其他工作区发送检查。唤醒聊天会使用模型调用，不额外创建每小时自动任务。

## 查看、停止与恢复

在检出目录运行以下命令，将 `<folder>` 替换为受协调工作区的绝对路径：

```sh
node packages/cli/bin/agentgit.mjs checks status --workspace <folder>
node packages/cli/bin/agentgit.mjs checks disable --workspace <folder>
node packages/cli/bin/agentgit.mjs desktop --clear-init --workspace <folder>
```

停止会保留回执。恢复时让当前聊天遵循 setup.md，复用已记录的协调聊天。
`.agentgit/state/spine.log` 和 `daemon.json` 用于诊断守护进程。
`/agentgit` 仍是“启用记录并置顶当前聊天、打开面板”的快捷入口；自动消息需要上述明确同意。

## 数据与发布

本机聊天 UUID、可执行文件路径和检查回执保存在 `.agentgit/state/`，不应发布。
共享账本可能含任务描述和文件路径，推送 `.agentgit/events/` 前请检查内容。
生成的 `.mcp.json`、`spine.json`、`hooks.json`、`hooks/hooks.json` 含绝对路径，应在安装时生成。
代码仓库提供模板和测试，使用者无需复用开发者的聊天、目录或自动任务。
