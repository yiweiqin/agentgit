# ISCC v0.1：最小数据契约

本目录定义 Intent-Scoped Change Capsule 的第一个可机器检查版本。它是 Git 之上的元数据契约，不修改 Git 对象，也不声称能够自动理解所有代码意图。

## 文件

- `iscc.schema.json`：JSON Schema Draft 2020-12；
- `example_capsule.json`：一个最小、可验证的示例；
- `validate_iscc.py`：只读 schema 验证器。

## 验证

```powershell
python -m pip install jsonschema
python 03_基准与标注/benchmark/iscc-v0.1/validate_iscc.py
```

验证器只检查字段、枚举、格式和哈希形状。它不判断任务是否重复、实体是否真的语义重叠、测试是否足够或变更是否安全。

## v0.1 的明确限制

- `scope.entities` 允许 `unknown`，因为实体抽取可能失败；
- `patch_sha256` 只证明文件完整性，不证明 patch 正确；
- `validation.status=passed` 只表示记录的检查通过，不代表所有项目不变量满足；
- schema 不规定具体 LLM、静态分析器或 Git 分支策略；
- 未来版本需要定义 schema 演进、撤销、签名和隐私脱敏规则。
