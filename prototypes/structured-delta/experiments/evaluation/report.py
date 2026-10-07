"""Render a self-contained audit report from persisted results (no prediction)."""

import argparse
import json
from pathlib import Path


def pct(v):
    return "—" if v is None else f"{100 * v:.1f}%"


def conflict_f1(m):
    p, r = m["conflict_precision"], m["conflict_recall"]
    return 2 * p * r / (p + r) if p is not None and r is not None and p + r else 0


def render(static, online, out):
    s = json.loads((static / "summary.json").read_text())
    o = json.loads((online / "summary.json").read_text())
    recs = [json.loads(p.read_text()) for p in sorted(static.glob("case*.json"))]
    full = s["methods"]["Full Structured Delta"]["aggregate"]
    baselines = {
        k: v["aggregate"]
        for k, v in s["methods"].items()
        if k.startswith(("B1", "B2", "B3"))
    }
    best = max(baselines, key=lambda k: conflict_f1(baselines[k]))
    supported = (
        conflict_f1(full) > conflict_f1(baselines[best])
        and full["compatible_false_positive_rate"]
        < baselines[best]["compatible_false_positive_rate"]
        and full["cross_file_conflict_recall"]
        > baselines[best]["cross_file_conflict_recall"]
    )
    text = [
        "# 结构化程序状态 delta：实验报告",
        "",
        "2026-10-07。从共同 base 的实际代码差异提取结构化变化；没有使用代理自述、gold、测试反馈或参考实现作为检测输入。",
        "",
        f"**结论：{'满足' if supported else '未满足'}协议预先规定的有限支持条件。** "
        + (
            "Full 在本轮构造样本上的冲突 F1、兼容误报率和跨文件召回优于最强可用简单基线。"
            if supported
            else "本轮不能支持结构化方法优于简单基线的有限命题。"
        ),
        "这不是总体假设的证明：样本和规则由同一实现者共同设计，没有独立留出集；B4/B5 未配置外部模型，无法检验“优于 embedding/LLM”的部分。",
        "",
        f"样本：{s['cases']} 个 Python 微型仓库、{s['families']} 个命名场景族；标签分布 `{s['labels']}`。"
        f"跨文件冲突 {s['cross_file_conflicts']} 个，指两个补丁修改文件集合完全不相交。定位分母 {full['denominators']['localization']} 个，排除 independent。",
        "",
        f"冻结时刻：`{s['freeze_created_at']}`。环境：Python {s['environment']['python']}；Git 2.43.0。"
        "实现/样本/协议哈希见 FREEZE.json；逐案例证据见 results/run-001（如为复跑则见本次指定目录）。",
        "",
        "## 可用方法比较",
        "",
        "B1/B2/B3 是二分类启发式，只输出 independent/conflicting；四分类 macro F1 天然受限。"
        "不能仅凭 macro F1 判断胜负，故同时列出冲突 F1、精确率/召回率、兼容误报和跨文件召回。"
        "定位为严格实体匹配，文件名不能替代函数/配置实体。",
        "",
        "| 方法 | Macro F1 | 冲突 P | 冲突 R | 冲突 F1 | 兼容 FP | 跨文件 R | Top-1 | R@3 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    methods = [
        "B1 File",
        "B2 Line",
        "B2 AST/Symbol",
        "B3 Git merge",
        "B4 Embedding",
        "B5 LLM descriptions",
        "Full Structured Delta",
    ]

    def row(k):
        if k not in s["methods"]:
            return f"| {k} | 未运行 | — | — | — | — | — | — | — |"
        m = s["methods"][k]["aggregate"]
        return (
            "| "
            + k
            + " | "
            + " | ".join(
                pct(v)
                for v in (
                    m["macro_f1"],
                    m["conflict_precision"],
                    m["conflict_recall"],
                    conflict_f1(m),
                    m["compatible_false_positive_rate"],
                    m["cross_file_conflict_recall"],
                    m["localization_top1"],
                    m["localization_recall3"],
                )
            )
            + " |"
        )

    text.extend(row(k) for k in methods)
    text += [
        "",
        f"最强简单基线按冲突 F1 为 {best}。B4/B5 状态：`{s['optional']}`。"
        "可选调用失败时保留错误和覆盖率，不用成功子集冒充全量。",
        "",
        "## 消融",
        "",
        "| 特征/规则束 | Macro F1 | 冲突 P | 冲突 R | 冲突 F1 | 兼容 FP | 跨文件 R | Top-1 | R@3 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    levels = [
        "File",
        "File + Symbol",
        "File + Symbol + Dependency",
        "File + Symbol + Dependency + Contract",
        "Full Structured Delta",
    ]
    text.extend(row(k) for k in levels)
    text += [
        "",
        "这些是特征和判定规则一起变化的阶梯消融：Contract 阶段才开始把无已知不兼容的相关变化判为 compatible；Full 同时加入读写、返回表达式和规范化重复识别。因此不能把差值严格解释为单一结构组件的因果收益。",
        "",
        "| 相邻阶段 | 冲突 F1 变化（百分点） | Macro F1 变化（百分点） |",
        "|---|---:|---:|",
    ]
    for prev, nxt in zip(levels, levels[1:]):
        m, n = s["methods"][prev]["aggregate"], s["methods"][nxt]["aggregate"]
        text.append(
            f"| {nxt} | {(conflict_f1(n) - conflict_f1(m)) * 100:+.1f} | {(n['macro_f1'] - m['macro_f1']) * 100:+.1f} |"
        )
    text += [
        "",
        "## 按场景类型的结果",
        "",
        "下表给出每个家族的 Full 结果；所有方法的逐族七项指标及混淆矩阵均在 summary.json。"
        "小家族只有 1–3 例，不能将单例的 0%/100% 当成稳定概率。",
        "",
        "| 类型 | n | 四分类正确数 | 冲突命中/真冲突 | 非冲突误报数 | 实体 Top-1 |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for family, m in s["methods"]["Full Structured Delta"]["by_family"].items():
        records = [r for r in recs if r["gold"]["family"] == family]
        correct = sum(
            r["gold"]["label"] == r["predictions"]["Full Structured Delta"]["label"]
            for r in records
        )
        positives = [r for r in records if r["gold"]["label"] == "conflicting"]
        tp = sum(
            r["predictions"]["Full Structured Delta"]["label"] == "conflicting"
            for r in positives
        )
        fp = sum(
            r["gold"]["label"] != "conflicting"
            and r["predictions"]["Full Structured Delta"]["label"] == "conflicting"
            for r in records
        )
        text.append(
            f"| {family} | {m['n']} | {correct} | {tp}/{len(positives)} | {fp} | {pct(m['localization_top1'])} |"
        )
    text += [
        "",
        "## 错误分析",
        "",
        "| 案例 | 真值 → 预测 | 类型 | 检测理由/实体 |",
        "|---|---|---|---|",
    ]
    for r in s["errors"]["Full Structured Delta"]["all_misclassified"]:
        pred = r["prediction"]
        text.append(
            f"| {r['id']} | {r['gold']} → {pred['label']} | {r['family']} | "
            + ("; ".join(pred["reasons"]) + "; " + ", ".join(pred["entities"])).replace(
                "|", "/"
            )
            + " |"
        )
    fps = s["errors"]["Full Structured Delta"]["false_positives"]
    fns = s["errors"]["Full Structured Delta"]["false_negatives"]
    text += [
        "",
        f"Full 冲突误报 {len(fps)} 个：`{[r['id'] for r in fps]}`；漏报 {len(fns)} 个：`{[r['id'] for r in fns]}`。",
        "误报风险来自保守的契约变化⇒失效、共享读写⇒冲突，以及未证明等价时把不同返回表达式视为互斥。"
        "漏报风险来自动态查找、外部状态、JSON 读取和分发解析缺失。按实际错误行判断本轮触发了哪些限制，不能把这些局限用增加同模板样本掩盖。",
        "更多限制：前后 reads/calls 的并集可能保留已移除的假设；未知类型和源代码注解不构成完整类型证明；manifest 尚未关联安装包到 import；同符号 compatible 默认也可能漏掉路径和执行顺序冲突。",
        "",
        "## 交换顺序和实际检查",
        "",
        "| 真值 | n | 两个 strict 顺序都适用 | strict 两序都通过联合测试 | 两个 three-way 都干净 | three-way 两序都通过联合测试 | 干净产物不同 |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for label in ("independent", "compatible", "redundant", "conflicting"):
        group = [r for r in recs if r["gold"]["label"] == label]

        def count(fn):
            return sum(fn(r["commutativity"]) for r in group)

        text.append(
            f"| {label} | {len(group)} | {count(lambda c: c['strict_patch']['both_apply'])} | "
            f"{count(lambda c: all(c['strict_patch'][k]['tests'] is not None and c['strict_patch'][k]['tests']['passed'] for k in ('ab', 'ba')))} | "
            f"{count(lambda c: c['three_way']['both_clean'])} | "
            f"{count(lambda c: all(c['three_way'][k]['tests'] is not None and c['three_way'][k]['tests']['passed'] for k in ('ab', 'ba')))} | "
            f"{count(lambda c: c['three_way']['states_differ'] is True)} |"
        )
    text += [
        "",
        "适用/合并失败时测试结果与产物比较为 null，不是失败测试或相同产物。"
        "冲突标记树、每个顺序的源码哈希、测试 stderr 和返回码均保留。three-way 是共同祖先文本合并，不是语义修复。"
        "联合测试并非完备 oracle；兼容案例的 witness 证明存在满足双方要求的组合，不代表 Git 已产生该组合。",
        "",
        "## 代表性案例",
        "",
    ]
    ids = [
        "case004",
        "case011",
        "case012",
        "case025",
        "case034",
        "case037",
        "case041",
        "case045",
        "case047",
    ]
    for cid in ids:
        r = next(v for v in recs if v["id"] == cid)
        g = r["gold"]
        p = r["predictions"]["Full Structured Delta"]
        text += [
            f"- **{cid} — {g['title']}**：真值 {g['label']}；B1={r['predictions']['B1 File']['label']}，Git={r['predictions']['B3 Git merge']['label']}，Full={p['label']}。{g['explanation']}"
        ]
    text += [
        "",
        "高文本相似既可能是兼容（case011/012），也可能是重复（case025）或冲突（case044）；跨文件契约变化（case034/037）即使补丁词面不同也会破坏消费者。"
        "这些是相似度不能定义语义冲突的机制反例；B4 未运行，不能声称某个 embedding 模型在这些案例实际失败。",
        "",
        "## 最小在线模拟",
        "",
        f"{o['cases']} 例、{o['events']} 个补丁事件。冲突检出 {o['conflicts_detected']}/{o['conflicting_cases']}；"
        f"非冲突误干预 {o['false_interventions']}/{o['nonconflicting_cases']}，严格“早于首次失败”的误干预 {o['false_early_interventions']}。"
        f"冲突案例有效 lead ticks：`{o['lead_ticks_conflicts']}`，均值 `{o['mean_lead_ticks_conflicts']}`；"
        f"单事件提取＋检测中位 {o['median_detection_ms']:.3f} ms（单次共享主机测量）。",
        "",
        "| 案例 | 真值 | 首次告警 | 首次 merge 失败 | 首次行为测试失败 | lead ticks | semantic lead | 误干预 |",
        "|---|---|---:|---:|---:|---:|---:|---|",
    ]
    for r in o["rows"]:
        text.append(
            "| "
            + r["id"]
            + " | "
            + r["label"]
            + " | "
            + " | ".join(
                "—" if r[k] is None else str(r[k])
                for k in (
                    "first_detection_tick",
                    "first_merge_failure_tick",
                    "first_test_failure_tick",
                    "lead_ticks",
                    "semantic_lead_ticks",
                    "false_intervention",
                )
            )
            + " |"
        )
    text += [
        "",
        "时间单位为事件序号；正 lead 才表示提前。缺失检测/失败时保留 null。"
        "轨迹只有“准备 helper、首文件修改、完成/清理”三个预设阶段，不能证明真实代理工作中能提前预警。"
        "要求在功能变化完整时立即激活，避免把清理阶段当作虚假的检测领先。静态标签也不能充分标注每个中间状态的临时冲突。",
        "",
        "## 对五个研究问题的回答",
        "",
        f"1. 结构化表示是否提高检测：本轮 Full 冲突 F1={pct(conflict_f1(full))}，最强简单基线={pct(conflict_f1(baselines[best]))}；有限支持判据={supported}，无外部泛化结论。",
        "2. 哪些组件最有用：看消融相邻差值；依赖边负责跨文件候选，契约规则区分部分相关但兼容的修改，Full 的重复识别和读写规则也会引入误报。混合规则束不能做纯组件因果归因。",
        f"3. 同作用域兼容误报：Full 兼容误报率 {pct(full['compatible_false_positive_rate'])}；仍应逐例看哪些误报由同作用域、契约或状态引发。",
        f"4. 跨文件冲突：Full 召回 {pct(full['cross_file_conflict_recall'])}（分母 {full['denominators']['cross_file_conflicting']}）；动态关系仍是明显盲点。",
        f"5. 实体定位：Top-1 {pct(full['localization_top1'])}、R@3 {pct(full['localization_recall3'])}；独立于类别判定评分，不能把定位正确当成冲突判断正确。",
        "",
        "## 唯一优先的下一项实验",
        "",
        "冻结当前实现，独立收集并盲标至少 100 个来自未见真实仓库的并发修改对，用可执行的双方要求裁决，重点覆盖向后兼容契约与动态跨文件依赖；B4/B5 在独立校准集固定模型和阈值后同轮运行。"
        "该迁移盲测优先于扩展同模板案例、接入路由或构建完整 AgentGit。",
        "",
        "实现文件与复现命令见 README.md / FILES.md。没有提交、推送、插件安装、模型调用或自动修复。",
        "",
    ]
    out.write_text("\n".join(text))
    print(out)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--static", type=Path, default=Path("experiments/results/run-001"))
    p.add_argument(
        "--online", type=Path, default=Path("experiments/results/online-001")
    )
    p.add_argument("--out", type=Path, default=Path("REPORT.md"))
    a = p.parse_args()
    render(a.static, a.online, a.out)
