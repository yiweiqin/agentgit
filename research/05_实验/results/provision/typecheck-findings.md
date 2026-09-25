# 类型校验抓出的问题（对照真实 DSH d.ts）

> 目的：`plugin.ts` 是照着文档写的，对 v0.1 preview 的每一条事件签名、decision 形状、导入路径都是**假设**。
> 176 个单测抓不到这些假设，因为测试 mock 的是同一套假设。
> 唯一能否证它们的是**对照真实发布的 `.d.ts`**。本次校验抓出 4 类问题，其中第 2 类是真 bug。
> 校验方式：`05_实验/harness/typecheck/`（`tsc --noEmit`，见 `integration-validation.md` §8）。

## 1. `tools/pre-execute` / `tools/post-execute` 不在 `keyof Events` 里

```
plugin.ts(182,10): error TS2345: Argument of type '"tools/pre-execute"' is not assignable to parameter of type 'keyof Events'.
plugin.ts(232,10): error TS2345: Argument of type '"tools/post-execute"' is not assignable to parameter of type 'keyof Events'.
```

**事件名本身是对的** —— 它们确实声明在 `@deepseek-ai/dsh-tools/lib/types/index.d.ts`：

```ts
'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>;
```

问题在于 `Events` 是**声明合并**（每个包 `declare module '@deepseek-ai/cordis'` 扩一份），而 `plugin.ts` 从未 import `@deepseek-ai/dsh-tools` —— 于是那份合并根本没进入编译单元。`session/*`、`fs/write-intent` 之所以没报错，是因为它们各自的包（`dsh-session`、`dsh-fs`）在导入图里。

**修法**：`plugin.ts` 显式 `import type { ... } from '@deepseek-ai/dsh-tools'`。`package.json` 本来就把 `dsh-tools` 列为 peerDependency，只是代码里没落实。

**为什么这条值得单独记**：它是一类**静默失效**的代表 —— 事件名写错时宿主不会报错，`ctx.on` 只是往一个没人 emit 的名字上挂监听器，插件从此什么都不做，而所有单测照常通过。这类错误在 E3 里会表现为"处理组与对照组无差异"，从而被误读成"协调无用"（I6 触发器）。现在类型校验把它挡在跑数据之前。

## 2. `safeHandler` 会毁掉宿主的 decision waterfall（真 bug）

```
plugin.ts(157,29): Argument of type '... => Promise<...> | undefined' is not assignable to parameter of type '... => Promise<...>'.
plugin.ts(292,28): 同上
```

`adapter.ts` 的 `safeHandler` 签名是 `(...args) => R | undefined`，失败时返回 `undefined`。对**观测型**监听器（`@mode emit`，返回值没人看）这是对的；但对 **waterfall** 型监听器是错的：返回 `undefined` 不等于"我没意见"，而是**把宿主本来要用的 decision 丢掉了**。

具体失效路径：监听器先 `await next()` 拿到宿主的 decision（例如 `tools/pre-execute` 的 `allow`），随后在计算 advisory 时抛异常 → `safeHandler` 把结果变成 `undefined` → 宿主拿到"没有 decision"而不是它自己刚产出的那个。

后果的严重性在于**双向的沉默**：插件会报告自己 0 故障（异常被吞），而 agent 实际上被弄坏了。在实验里这会变成处理组随机失败，且失败原因被归到"治理"头上。

**修法**：新增 `guardDecision(name, fallback, compute, onError)`，只在插件**自己的贡献**外面兜底，`fallback` 就是 `next()` 已经产出的那个 decision。最坏情况因此从"弄坏宿主"降级为"这个插件没贡献"，而这正是一个不该承重的组件唯一可接受的失败模式。同时明确：`next()` 自身的 rejection **不**在这里兜 —— 那时没有任何合法 decision 可作 fallback，编造一个只会把宿主故障伪装成插件的沉默。

## 3. `fromWire` 把 wire 的 `kind: string` 直接塞进 `CoordEventKind`

```
ledger.ts(165,5): error TS2322: Type 'string' is not assignable to type 'CoordEventKind'.
```

`WireEvent.kind` 故意是裸 `string`（wire 格式与 `coord_ledger.py` 共享，对方可能写出这一侧还不认识的 kind）。而 `fromWire` 需要的是 `CoordEventKind`，之前靠隐式转换过去。

**为什么不能容忍**：下面所有派生逻辑都 `switch on kind`。一个不认识的 kind 若悄悄穿过那些 switch，会被**计为一个事件**，却不贡献任何 capsule、任何 entity touch、任何速率 —— 与"这个事件从未发生"在数字上无法区分。

**修法**：加 `narrowKind()`，不在 `ALL_EVENT_KINDS` 里就抛错，错误信息同时带上 kind 和 event_id。这与 `readLedger` 已有的取舍一致（账本文件不存在时抛错而不是返回空数组）：**解释不了自己输入的工具，不应该基于它报告数字**。两个分析器若词汇表分歧，这一点必须从失败信息里就能诊断出来。

## 4. 三处测试调用已过期的签名

```
governor.test.ts(91,35): Expected 1 arguments, but got 2.
governor.test.ts(230,35): 同上
governor.test.ts(354,35): 同上
```

`noteCompaction(sessionId)` 现在只接受一个参数（taskId 改由 `#sessionTask` 推导），但三处测试仍在传两个参数。JS 允许多余实参，所以**测试一直在悄悄忽略它传的 taskId 并照样通过** —— 也就是它们断言的行为和它们以为的已经不是一回事。

**修法**：按当前签名修正调用，并把第 91 行那处**加强**为真正覆盖 H3 依赖的那条路径（先声明 task，再 compaction，然后断言 `taskId === 'T1'` 且 `taskIdSource === 'session-derived'`），而不是让它退化成 `session-fallback`。第 230、354 行依赖 `contestedRuntime` 已经声明过 `T2`，因此单参数版本走的就是 `session-derived`，与该测试的原意一致。

## 5. 未被抓出但已人工确认正确的假设

类型校验只覆盖签名。以下是通过**阅读真实 d.ts** 确认的语义假设，一并记录，因为它们同样是"文档说了但可能不是这样"的部分：

| 假设 | 真实定义 | 结论 |
|---|---|---|
| `fs/write-intent` 是 single-slot waterfall，返回 `undefined` 表示不接管 | `@mode waterfall`，注释原文："the first listener that returns an intent owns the decision rather than composing with peers" | ✅ 与 `plugin.ts` 的返回策略一致 |
| `PreToolDecision` 有 `{kind:'deny', reason}` 与 `{kind:'ask', reason?}` | 完全一致 | ✅ |
| `PostToolDecision` 的 `accept` 变体带 `additionalContexts?: UserMessage[]` | 完全一致（且 `accept` 有两个变体，`{...decision}` 展开才能保住 `value` 形状） | ✅ |
| `PreStepDecision` 的 `enter` 变体带 `messages: UserMessage[]` | 完全一致 | ✅ |
| `createUserMessage({content, source})` 接受 `source: {kind:'plugin', plugin, form:'snapshot', sections}` | `MessageSourceMap['plugin'] = {kind:'plugin', plugin} & ContextFormed`，`ContextFormed` 含 `{form:'snapshot', sections}` | ✅ |
| `sessionIdOf` 能从宿主对象提取 session id | `Agent { readonly id: SessionId }` | ✅（`SessionId` 是 branded string，运行时仍是 string） |
| compaction 经 `session/event` feed 到达，而非独立事件 | `'session/event'(this, session: Session, event: SessionEvent): void`，`@mode emit` | ✅ 且已被真实运行证实（见 `integration-validation.md` §2） |

## 6. 现在的门禁状态

| 门禁 | 结果 |
|---|---|
| `node --test "tests/**/*.test.ts"` | **176 通过 / 0 失败** |
| `tsc --noEmit`（对照真实 d.ts） | **0 错误** |
| 插件在真实 DSH 中加载并触发钩子 | **已证实**（observer 半边） |
