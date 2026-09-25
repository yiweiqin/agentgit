# 远程实验机评估：规格符合性

> 结论：**该机器不满足 E1/E3 的硬性要求**。它可以勉强承载「单会话集成验证」（E0/E2 的傀儡会话端到端），但不能承载以并发为自变量的主实验。
> 测量时间：2026-09-15。所有数字均从容器内部实测，不采信主机自报值。

## 1. 实测结果 vs 计划要求

计划（`preregistration` 前置的 §0）给出的最低规格是 8 vCPU / 32 GB / 200 GB SSD / 完整 KVM VM。
实测：

| 要求 | 计划最低 | 本机实测 | 判定 |
|---|---|---|---|
| 完整 VM（非共享容器） | KVM 云主机 | Docker 容器（`systemd-detect-virt: docker`） | **FAIL** |
| vCPU | ≥ 8 | **~1 个有效核**（cgroup 配额 0.5） | **FAIL（差 ~8×）** |
| 内存 | ≥ 32 GB | **2 GiB**（`memory.max` 硬上限） | **FAIL（差 16×）** |
| 磁盘 | ≥ 200 GB | `/root/autodl-tmp` 250 GB（`/dev/md0`），`/` 仅 30 GB | PASS |
| 内核 | ≥ 5.13 | 5.15.0-94-generic | PASS |
| 非特权 user namespace | 允许 | **全部 namespace 被封**（见 §3） | **FAIL**（有部分替代路径） |
| root / sudo | 需要 | uid=0 | PASS |
| 出站 HTTPS 到 api.deepseek.com | 需要 | 401（可达，仅缺鉴权） | PASS |
| Node ≥ 24 / pnpm / git / python3 | 需要 | 见 §5，需自装 Node | PASS（需配置） |

## 2. CPU：整条链路里最致命的一项

主机自报 208 vCPU / 754 GB，容器实际只给 0.5 CPU 配额（`cpu.max = 50000 100000`，即 50000µs / 100000µs 周期）。这两个数字差 400 倍，只有后者是真实的。

实测吞吐（同一份整数负载，判据是**墙钟时间**而非绝对分数）：

| 测量 | 结果 |
|---|---|
| 单进程 6M 次迭代 | 4.28 s |
| 8 个进程并行（每个 2M 次迭代） | **9.91 s** |

8 个并行进程的工作量合计约 11.4 CPU·秒。若真有 8 个核，墙钟应接近单进程耗时（~1.4 s）；实测 9.91 s，折合**约 1.15 个有效核**，几乎完全串行。

容器还在被节流：`nr_throttled 276 / nr_periods 4631`，`throttled_usec 55.8s` 已超过 `usage_usec 24.8s`——即空载状态下就已触发限流。

### 为什么这对实验是致命的，而不是"慢一点"

E1/E3 的**自变量就是并发**：开发者数 × 每人会话数 × 任务重叠密度。计划明确要求 4–8 个并发 dsh 会话。

在 ~1 核上跑 8 个并发会话，会产生一个**效度威胁**而非仅仅是速度问题：

- 每个会话只能拿到约 12% 的核，会话之间被迫串行。此时瓶颈是 CPU 争抢，而不是协调失效——**争用被机器制造出来，而不是被工作负载制造出来**。
- \(B(t)\) 可能因此**不增长**（因为一切串行，天然不会产生重叠写入窗口），从而把「现象不存在」（K1/K2）误判为真。这是假阴性风险，会直接推翻中心假设。
- 反之，若 \(B(t)\) 因为任务本身（pytest、tsc）互相拖慢而增长，测到的也是 CPU 饥饿的伪影，不是协调信号。

即：**这台机器无法区分"协调失效"与"CPU 饥饿"**，而这恰好是 E1/E3 要测的东西。

## 3. 沙箱：bwrap 完全不可用，但 Landlock 可作替代

计划要求完整 VM 的核心理由就是 DSH 沙箱。实测：

```
user: BLOCKED    mount: BLOCKED   pid: BLOCKED   uts: BLOCKED
ipc:  BLOCKED    net:   BLOCKED   cgroup: BLOCKED
```

**即使以 root（uid=0）运行，所有 namespace 都被封**。bwrap 的所有变体均失败：

```
bwrap: Creating new namespace failed: Operation not permitted
```

包括不加任何 namespace 标志的最小调用（`bwrap_minimal_exit=1`）和可写 bind 挂载（`writable_bind_exit=1`）。因此 `bwrap` 路径**彻底不可用**，计划的"唯一有 e2e 测试的沙箱路径"在此机器上不存在。

**但有一条替代路径**：Landlock 是 LSM 系统调用，不需要任何 namespace。实测：

```
landlock: SUPPORTED (ABI 1)
```

DSH 的 `@deepseek-ai/dsh-sandbox-local` 在 Linux 上走 `bwrap`，**否则回落到 per-platform Landlock launcher**。所以 DSH 在此机器上应当能选到 Landlock 后端，而不是 fail-closed。

需要如实记录的代价：内核 5.15 对应 **Landlock ABI 1**，是文档明确列举的 `partial` enforcement 情形（ABI 1 缺少 `REFER`、`TRUNCATE` 等权限）。也就是说沙箱是"能跑但承诺不完整"，与计划要求的完整 VM 不等价。这一点必须在实验记录里写明，不能当作等价替代。

## 4. 内存：2 GiB 是硬上限，但不是立刻致命的

- `memory.max = 2 GiB` 硬上限，无 swap（`swap.max` 不存在）。
- 实测单进程持有 1.4 GiB 成功，未触发 OOM（`memory.events` 全 0）。所以不是"一碰就死"。
- 但 8 个 Node 会话 × 150–250 MB ≈ 1.2–2.0 GB，正好压在上限上。`pnpm install` 一个 monorepo 就可能打满。

结论：内存**限制了并发会话数**，与 §2 的 CPU 限制叠加，共同把可用并发压到 1–2 个会话。

## 5. 工具链现状

| 工具 | 现状 | 备注 |
|---|---|---|
| node | `/usr/bin/node` = **v12.22.9** | 太旧，DSH 要求 ^22.19 或 ≥24 |
| node (备用) | `/opt/node24` 已存在 v24 | 未在 PATH 中，需软链 |
| pnpm | 缺失 | 需 corepack 或 npm -g 安装 |
| npm | 8.5.1 | 随 node12 |
| git | 2.34.1 | 可用 |
| python3 | 3.10.12 | 可用 |
| zstd | 1.4.8 | 可用，可读 `session*.jsonl.zstd` |
| curl | 7.81.0 | 可用 |

网络实测：`registry.npmjs.org` 200、`github.com` 200、`api.deepseek.com` 401（可达，缺鉴权）、`nodejs.org` 307。

**关键利好**：DSH 的包**已发布到 npm**，无需编译 monorepo。这消除了在 2 GiB / 1 核上构建大型 TS monorepo 的 OOM 风险——这一点比预期重要，它把本机的用途从"完全不可用"提升到"可做单会话集成验证"。

| 包 | latest |
|---|---|
| `@deepseek-ai/dsh` | 0.1.5-rc.1 |
| `@deepseek-ai/dsh-tools` | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-agent` | 0.1.0-rc.6 |
| `@deepseek-ai/dsh-fs` | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-llm` | 0.0.1-rc.1 |
| `@deepseek-ai/dsh-session` | 0.0.1-rc.1 |
| `@deepseek-ai/cordis` | 4.0.2 |
| `@deepseek-ai/schemastery` | 3.18.2 |

## 6. 结论与建议

**本机可以做的**（低并发，价值真实）：

1. 装 Node v24 + DSH，跑通 **headless 单会话**——这是 `provision` 待办的核心内容。
2. **集成验证**：插件在真实 DSH 里能否加载、`fs/write-intent` / `session/event` / `tools/pre-execute` 等钩子是否真的触发、账本是否落盘、`llm-replay` 是否可用。这是当前最大的未知（`plugin.ts` 目前只对着文档写，没被真实宿主验证过），而且**不需要并发**。
3. 用真实 `session*.jsonl.zstd` 做 E0 的交叉校验（计划里标注"待远程机"的那一半）。

**本机做不了的**：

- **E1（现象存在性）与 E3（A0–A4 主实验）**。它们的自变量是并发，而本机只有约 1 个核。在此跑出的 \(B(t)\) 曲线无法区分协调失效与 CPU 饥饿，可能产生关于中心假设的假阴性。
- E7（规模与泛化）中的并发上扫，同理。

**建议**：E1/E3 需要计划中所述的完整 VM（8–16 vCPU / 32–64 GB）。若一时拿不到，本机仍应承担第 1–3 项，因为它们是主实验的前置条件，且与机器规格无关。
