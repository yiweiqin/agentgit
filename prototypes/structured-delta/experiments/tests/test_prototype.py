import unittest
from experiments.delta.extractor import extract
from experiments.delta.interaction import detect
from experiments.delta.model import Prediction
from experiments.evaluation.metrics import score
from experiments.evaluation.runtime import merged_pair, strict_order, digest
from experiments.benchmark.build import patch
from experiments.baselines import embedding, llm_intent
from experiments.online.sequences import stages, functional_complete


class ExtractorTests(unittest.TestCase):
    def test_alias_and_relative_import(self):
        base = {
            "pkg/__init__.py": "",
            "pkg/api.py": "def f(x): return x\n",
            "pkg/c.py": "from .api import f as fetch\ndef run(): return fetch(1)\n",
        }
        a = {**base, "pkg/api.py": "def f(x,y): return x+y\n"}
        b = {
            **base,
            "pkg/c.py": "from .api import f as fetch\ndef run(): return fetch(2)\n",
        }
        result = detect(extract(base, a), extract(base, b))
        self.assertEqual(result.label, "conflicting")
        self.assertEqual(result.entities, ["pkg/api.py::f"])

    def test_none_eq_is_not_identity(self):
        base = {"m.py": "def f(x): return x\n"}
        a = {"m.py": "def f(x):\n    if x is None: return 0\n    return x\n"}
        b = {"m.py": "def f(x):\n    if x == None: return 0\n    return x\n"}
        self.assertNotEqual(
            detect(extract(base, a), extract(base, b)).label, "redundant"
        )

    def test_constant_fields_do_not_alias(self):
        base = {"m.py": 'D={"a":0,"b":0}\ndef a(): D["a"]=1\ndef b(): D["b"]=1\n'}
        a = {"m.py": base["m.py"].replace('D["a"]=1', 'D["a"]=2')}
        b = {"m.py": base["m.py"].replace('D["b"]=1', 'D["b"]=3')}
        self.assertEqual(
            detect(extract(base, a), extract(base, b)).label, "independent"
        )

    def test_removed_call_records_conservative_reads(self):
        base = {
            "api.py": "def get(): return 1\n",
            "c.py": "from api import get\ndef f(): return get()\n",
        }
        changed = {**base, "c.py": "from api import get\ndef f(): return 2\n"}
        self.assertIn("api.py::get", extract(base, changed).reads)

    def test_parse_error_recorded_not_silently_valid(self):
        d = extract({"x.py": "def f(): return 1\n"}, {"x.py": "def f(:\n"})
        self.assertTrue(d.unresolved)

    def test_rename_has_evidence(self):
        d = extract({"x.py": "def a(): return 1\n"}, {"x.py": "def b(): return 1\n"})
        self.assertIn(
            {"entity": "x.py::a", "operation": "rename", "to": "x.py::b"}, d.operations
        )

    def test_deletion_redundancy_and_order_symmetry(self):
        base = {"x.py": "def f(): return 1\n"}
        a = {"x.py": "# gone\n"}
        d = extract(base, a)
        self.assertEqual(detect(d, d).label, "redundant")
        e = extract(base, {"x.py": "def f(): return 2\n"})
        self.assertEqual(detect(d, e).label, detect(e, d).label)


class MetricsTests(unittest.TestCase):
    def test_denominators_and_exact_entity_localization(self):
        rows = [
            {
                "gold": "compatible",
                "family": "a",
                "cross_file": False,
                "entities": ["m.py::f"],
                "prediction": Prediction("conflicting", ["file:m.py"], 1, []).to_dict(),
            },
            {
                "gold": "conflicting",
                "family": "b",
                "cross_file": True,
                "entities": ["m.py::g"],
                "prediction": Prediction("conflicting", ["m.py::g"], 1, []).to_dict(),
            },
            {
                "gold": "independent",
                "family": "a",
                "cross_file": True,
                "entities": [],
                "prediction": Prediction("independent", [], 0, []).to_dict(),
            },
        ]
        result = score(rows)
        self.assertEqual(result["conflict_precision"], 0.5)
        self.assertEqual(result["compatible_false_positive_rate"], 1)
        self.assertEqual(result["cross_file_conflict_recall"], 1)
        self.assertEqual(result["localization_top1"], 0.5)
        self.assertIsNone(score([])["conflict_precision"])


class GitTests(unittest.TestCase):
    def test_clean_cross_file_merge_can_fail_semantically(self):
        base = {
            "api.py": "def f(): return 1\n",
            "c.py": "from api import f\ndef g(): return f()\n",
        }
        a = {**base, "api.py": 'def f(): return "one"\n'}
        b = {**base, "c.py": "from api import f\ndef g(): return f()+1\n"}
        result = merged_pair(
            base, a, b, {"requirement": "from c import g\nassert g()==2"}
        )
        self.assertTrue(result["both_clean"])
        self.assertFalse(result["ab"]["tests"]["passed"])
        self.assertFalse(result["states_differ"])

    def test_patch_creation_deletion_exactness(self):
        base = {"old.py": "X=1\n"}
        final = {"new.py": "X=2\n"}
        result = strict_order(base, [patch(base, final)], {})
        self.assertTrue(result["applied"])
        self.assertEqual(result["state_hash"], digest(final))

    def test_text_overlap_is_not_semantic_truth(self):
        base = {"m.py": "def f(x): return x\n"}
        a = {"m.py": 'def f(x):\n    """identity"""\n    return x\n'}
        b = {"m.py": "def f(x):\n    if x is None: return 0\n    return x\n"}
        self.assertFalse(merged_pair(base, a, b)["both_clean"])
        self.assertEqual(detect(extract(base, a), extract(base, b)).label, "compatible")


class InterfaceTests(unittest.TestCase):
    def test_optional_interfaces_without_network(self):
        from unittest.mock import patch as mock

        d = extract({"m.py": "X=1\n"}, {"m.py": "X=2\n"})
        with mock.object(
            embedding,
            "invoke",
            return_value={
                "vectors": [[1.0, 0.0], [0.0, 1.0]],
                "model": "fixture",
                "usage": None,
            },
        ):
            self.assertEqual(
                embedding.predict("unused", "a", "b", d, d).label, "independent"
            )
        with mock.object(
            llm_intent,
            "invoke",
            side_effect=[
                {"description": "A"},
                {"description": "B"},
                {"label": "compatible", "entities": ["m.py::X"]},
            ],
        ):
            self.assertEqual(llm_intent.predict("unused", "a", "b").label, "compatible")

    def test_stage_completion_is_not_delayed_to_cleanup(self):
        base = {"m.py": "X=1\n"}
        final = {"m.py": "X=2\n"}
        seq = stages(base, final, "a")
        self.assertFalse(functional_complete(seq[0], final))
        self.assertTrue(functional_complete(seq[1], final))
        self.assertTrue(functional_complete(seq[2], final))


if __name__ == "__main__":
    unittest.main()
