"""Serializable observations inferred exclusively from source snapshots."""

from dataclasses import dataclass, field, asdict
from typing import Any

LABELS = ("independent", "compatible", "redundant", "conflicting")


@dataclass
class Symbol:
    entity: str
    kind: str
    start: int
    end: int
    canonical: str
    signature: dict = field(default_factory=dict)
    returns: list[str] = field(default_factory=list)
    return_exprs: list[str] = field(default_factory=list)
    reads: list[str] = field(default_factory=list)
    writes: dict[str, list[str]] = field(default_factory=dict)
    calls: list[dict] = field(default_factory=list)
    statements: list[str] = field(default_factory=list)
    value: str | None = None


@dataclass
class ProgramDelta:
    files: list[str]
    symbols: list[str]
    operations: list[dict]
    reads: list[str]
    writes: dict[str, list[str]]
    signatures_before: dict
    signatures_after: dict
    types_before: dict
    types_after: dict
    dependencies_added: list[str]
    dependencies_removed: list[str]
    contracts_changed: dict
    imports: list[str]
    calls: list[dict]
    ast_operations: list[dict]
    lines: dict[str, list[int]]
    before: dict[str, Symbol]
    after: dict[str, Symbol]
    unresolved: list[str]

    def to_dict(self):
        return asdict(self)


@dataclass
class Prediction:
    label: str
    entities: list[str]
    score: float
    reasons: list[str]
    signals: dict[str, Any] = field(default_factory=dict)

    def to_dict(self):
        return asdict(self)
