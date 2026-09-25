# 集成验证：插件在真实 DSH 中加载并触发钩子

> 结论：**observer 半边已在真实 DSH 中得到端到端验证**（插件加载 + `session/created` + `session/event` 钩子触发 + 账本落盘）。
> 未验证部分（`fs/write-intent` / `tools/pre-execute` / `tools/post-execute` / `agent/pre-step`）**需要一个可用的模型凭据**才能真正执行工具调用。
> 验证时间：2026-09-15。

## 1. 环境（已锁定）

| 项 | 值 |
|---|---|
| DSH 版本 | `@deepseek-ai/dsh` **0.1.5-rc.1**（npm 安装，非 monorepo 构建） |
| 依赖包 | 241 个 `@deepseek-ai/*`，其中 `dsh-fs`/`dsh-agent`/`dsh-llm`/`dsh-tools`/`dsh-session` 均为 **0.1.5-rc.2** |
| 完整版本清单 | `05_实验/harness/dsh-types-manifest.txt`（类型校验的可复现依据） |
| Node | v24（`/opt/node24`，镜像自带的 `node` 是 v12.22.9，过旧） |
| pnpm | 12.4.2 |
| profile | `headless`（**DSH 自带模板**，无需创建） |
| 注册表 | `registry.npmmirror.com`（见 §6，这是能否装上的关键） |

## 2. 已证实的事（有账本为证）

一次真实 `dsh --profile headless "..."` 运行后，`ledgers/A1-instrument.jsonl` 被创建，内容为：

```
{"event_id":"evt-597dbb2dd3ac939899d5a79f","schema_version":"coord-ledger-0.1","kind":"session_started",
 "timestamp_utc":"2026-09-15T15:36:36.270Z","session_id":"session-ee6e3843-...",
 "host_event":"session/created","detail":{"taskIdSource":"unattributed"}}
{"event_id":"evt-fe491a5fce9e3c5f956b34f6","schema_version":"coord-ledger-0.1","kind":"turn_ended",
 "timestamp_utc":"2026-09-15T15:36:40.275Z","session_id":"session-ee6e3843-...",
 "host_event":"turn/end","detail":{"taskIdSource":"unattributed"}}
```

这一小段同时验证了 6 件事，每一件都是此前只能靠文档推断的：

1. **插件被真实宿主的 loader 加载**（`Config` schema 校验通过、`apply()` 执行）。
2. **`session/created` 钩子真的触发**，且 `session.id` 能被 `sessionIdOf` 提取（不是回退成匿名 id）。
3. **`session/event` 钩子真的触发**，且 `event.type === 'turn/end'` 匹配成功 —— 这直接验证了 `plugin.ts` 里那条最危险的注释：compaction 类事件走 `session/event` feed，而不是独立的 Cordis 事件。若写错，H3 探针会永远读 0。
4. **`#attribute` 的 `unattributed` 分支工作正常**：`session_started` / `turn_ended` 记为 `task_id: null`，不会开出一个永不闭合的幽灵 capsule 去永久抬高 \(B(t)\)。
5. **账本落盘正常**：目录自动创建、JSONL 逐行追加、wire 格式与 `coord_ledger.py` 的 `coord-ledger-0.1` 一致。
6. **插件在失败路径上不破坏宿主**：同一轮里模型调用因缺凭据而失败（`MISSING_CREDENTIAL`），但插件没有把宿主的 decision 吞掉（这正是本轮类型校验抓出的那个 bug，见 §5）。

## 3. 唯一的阻塞：模型凭据

```
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official";
store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it),
or export DEEPSEEK_API_KEY in the launching environment
```

**重要发现（影响试验设计）**：`llm-replay` **不是**可以凭空造一个桩模型的东西。它的 README 明确写着：

> It yields model streams reconstructed from a recorded **session JSONL** fixture … Recording is therefore "run the real agent once and harvest the `.jsonl`", done by the snapshot harness — **this plugin does not record.**

也就是说 `llm-replay` 是**回放**，不是**合成**。计划 §5 写「种子固定 + `llm-replay` 用于确定性臂」这一步仍然成立，但它的**前置条件**是先用真实 API 录一份 `session.jsonl` 夹具。推论：

- 确定性臂的**第一阶段必然要烧一次真实 API**（每个场景至少一次），之后才能零成本重复回放。
- 因此「API key 只在远程机环境变量里」这条纪律不变，但实验流程需要多一个**录制阶段**：真实跑一次 → 产出夹具 → 回放 N 轮。
- 这也意味着 E3 的「同种子 N 轮」必须在**同一份夹具**上做，否则比较的就不是同一个模型轨迹。

结论：**在拿到 `DEEPSEEK_API_KEY` 之前，任何会话（真实或回放）都无法跑完。**

## 4. 插件装载机制（已跑通的做法）

profile 的组装方式与本插件最相关的两点：

- profile 目录：`$DSH_HOME/profiles/headless/`，其中 **`cordis.patch.yml` 是唯一的用户层**（`cordis.yml` 是 bundle 合成结果，不该手改）。
- 挂载插件就是往 `cordis.patch.yml` 插一行 `insert`，按 **包名** 引用：

```yaml
- insert:
    - id: coord-governor
      name: dsh-coord-governor
      config:
        arm: A1-instrument
        ledgerPath: /root/autodl-tmp/coord-exp/ledgers/A1-instrument.jsonl
```

`arm` 放在 config 里而不是由 harness 另行传入，是为了让**账本自己携带臂身份**：一轮数据不可能被错误地归到别的臂上。

## 5. 部署约束：两个要求相互拉扯（本轮最有价值的发现）

原始 .ts 插件要在 DSH 里加载，必须同时满足两个看似矛盾的条件：

| 要求 | 原因 |
|---|---|
| **必须在 `node_modules` 之外解析** | Node 拒绝为 `node_modules` 下的文件做类型擦除：`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`（已实测复现）。插件不发构建产物、直接跑 `.ts`，所以这条是硬的。 |
| **必须能解析到自己的 peer 依赖** | Node 按**真实路径（realpath）**解析模块。profile 用 pnpm `link:` 安装插件，真实路径在任何 `node_modules` 之外，于是 `@deepseek-ai/schemastery` 找不到。 |

第一次装载就是这样失败的：`Cannot find package '@deepseek-ai/schemastery' imported from .../src/plugin.ts`。

**解法**：给插件自己的 `node_modules`，并把宿主那套包**软链**进去（一条 scope 级软链即可）：

```
$PLUGIN/node_modules/@deepseek-ai -> $HOST/node_modules/@deepseek-ai
```

这样两个要求同时满足：`.ts` 的真实路径仍在 `node_modules` 之外（类型擦除可用），依赖又能解析到与宿主**完全相同的版本**（不会出现第二套解析结果）。

这条约束必须写进 harness，否则每个臂/轮重建环境时都会再踩一次。

## 6. 装机环节的坑（记录以免重演）

- **`registry.npmjs.org` 不可用**：单次 metadata 请求约 2.5s，而 `@deepseek-ai/dsh` 有 72 个直接依赖。第一次 `npm install` 跑了 12 分钟、缓存只涨 1MB、`node_modules` 仍是空的（进程停在 `ep_poll`，是**网络等待**不是 CPU）。换 `registry.npmmirror.com`（约 0.48s）后 **47 秒**装完。
- **pnpm 默认不执行依赖的构建脚本**（`ERR_PNPM_IGNORED_BUILDS`）。本例中 `node-pty`、`koffi` 自带 prebuild，实测都能 `require` 成功，所以未造成影响；但这是一个需要在换宿主包版本时复查的点。
- **PowerShell 会吃掉远程 shell 命令里的引号**，导致远端报出误导性的语法错误。所有多行/含引号的操作都走 `remote.py script`（管道给 `bash -s`），并把脚本文件的 UTF-8 BOM 在传输前剥掉（否则 shebang 会变成 `/usr/bin/env: No such file or directory`）。

## 7. 仍未验证的部分

需要真实工具调用才能触发，因此需要 API key：

- `fs/write-intent`（\(\lambda_{\text{produced}}\) 的唯一权威观测点）
- `tools/pre-execute`（admission gate 的实际 deny/ask）
- `tools/post-execute`（advisory 注入 + `write_settled`）
- `agent/pre-step`（跨会话 overview 注入）

这四处是**插件价值主张的全部载体**。E0 的合成流交叉校验已经覆盖了它们的逻辑，但没有覆盖它们的**钩子签名在真实宿主里是否真的按预期触发**——本轮 §2 证明了这个担心是合理的（`session/event` 那条就差点写错）。

## 8. 类型校验（新增的常设门禁）

新增 `05_实验/harness/typecheck/`：把 DSH 真实的 `.d.ts`（241 包 / 1339 个 `.d.ts` / 1.1 MB）取回本地，用 `tsc --noEmit` 校验插件源码。运行方式：

```bash
cd 04_协调插件/dsh-coord-governor && npm run typecheck
```

首次运行即抓出 4 类真问题（详见 `05_实验/results/provision/typecheck-findings.md`），其中 `safeHandler` 那个能让插件**悄悄破坏宿主的 decision waterfall**。这个门禁现在与 176 个单测、E0 交叉校验并列，成为跑数据前的必过项。
