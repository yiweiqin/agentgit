# Documentation / 文档目录

[English README](../README.md) · [中文 README](../README.zh-cn.md)

README introduces the product with simple diagrams. Detailed instructions live here, grouped by purpose.
README 用简图介绍产品；详细说明按用途集中在以下四类文档中。

| Purpose / 用途 | English | 简体中文 |
| --- | --- | --- |
| Install, enable alerts, use tools, troubleshoot / 安装、提醒、操作、排查 | [Usage](USAGE.md) | [使用说明](USAGE.zh-cn.md) |
| Components, state, detection and delivery / 组件、状态、检测与消息链路 | [Architecture](ARCHITECTURE.md) | [系统架构](ARCHITECTURE.zh-cn.md) |
| Dependencies and notification rules / 依赖关系与提醒规则 | [Cross-session impact](CROSS-SESSION-IMPACT.md) | [跨会话影响分析](CROSS-SESSION-IMPACT.zh-cn.md) |
| Tests, reproducible examples and measurement limits / 测试、复现与测量边界 | [Experiments](EXPERIMENTS.md) | [实验与验证](EXPERIMENTS.zh-cn.md) |

The plugin also carries operational instructions for Codex agents. These are required runtime references, rather than additional user guides:
插件另有供 Codex agent 执行的协议文件，运行时需要保留：

- [Skill entry / 技能入口](../plugins/agentgit/skills/agentgit/SKILL.md)
- [Workspace setup / 工作区启用协议](../plugins/agentgit/skills/agentgit/references/setup.md)
- [Cross-chat checks / 跨聊天检查协议](../plugins/agentgit/skills/agentgit/references/coordinate.md)
- [Optional read-only monitor / 可选只读监控](../plugins/agentgit/skills/agentgit/references/watch.md)

Superseded project overview and separate automatic-check instructions have been folded into the architecture and usage guides. Experiment instructions now live under `docs/` in both languages.
旧项目总览和单独的自动检查文档已并入架构、使用说明；实验说明统一放在 `docs/`，提供中英文入口。
