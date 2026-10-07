"""Regression coverage for cross-version verification and exact integrity."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from verify_source import digest, verify


class SourceVerificationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.module = self.root / "experiments/__init__.py"
        self.module.parent.mkdir()
        self.module.write_bytes(b'"""Source fixture."""\n')
        protocol = b"Test protocol\n"
        (self.root / "PROTOCOL.md").write_bytes(protocol)
        manifest = {
            "protocol_sha256": digest(protocol),
            "modules": {
                "experiments/__init__.py": {
                    "published_sha256": digest(self.module.read_bytes()),
                    "program_ast_sha256": digest(b"Historical interpreter AST dump"),
                }
            },
        }
        (self.root / "SOURCE_PROVENANCE.json").write_text(json.dumps(manifest))

    def test_historical_ast_format_does_not_reject_identical_source(self):
        with patch("ast.dump", side_effect=AssertionError("Not cross-version stable")):
            verify(self.root)

    def test_even_semantically_identical_source_edits_are_rejected(self):
        self.module.write_bytes(self.module.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "Published source changed"):
            verify(self.root)

    def test_unrecorded_modules_are_rejected(self):
        (self.module.parent / "extra.py").write_text("VALUE = 1\n")
        with self.assertRaisesRegex(ValueError, "module inventory"):
            verify(self.root)


if __name__ == "__main__":
    unittest.main()
