"""Offline tests: the real release shell is exercised only with a mocked gh."""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from scripts.release_manifest import build_manifest, file_identity
REPO = Path(__file__).resolve().parents[1]
NEW_SHA = "a" * 40
OLD_SHA = "b" * 40
NEW_TAG = f"openclaw-{NEW_SHA[:12]}"
OLD_TAG = f"openclaw-{OLD_SHA[:12]}"
NEW_BYTES = b"\x7fELFnew-runtime"
OLD_BYTES = b"\x7fELFold-runtime"
def base_manifest():
    return {"updated": "2026-10-31T00:00:00Z", "shells": {"openclaw": {"sha": NEW_SHA, "tag": NEW_TAG}}}
def prior_entry(data=OLD_BYTES):
    return {"shell": "openclaw", "target": "linux-arm64", "sourceTag": OLD_TAG,
            "sourceSha": OLD_SHA, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.stage = Path(self.temp.name)
        self.base = base_manifest()
    def asset(self, target="linux-amd64", data=NEW_BYTES, previous=False):
        name = f"openclaw-{target}" + (".exe" if target == "windows-amd64" else "")
        (self.stage / name).write_bytes(data)
        return [name, "openclaw", target, "previous-latest" if previous else NEW_TAG, "-" if previous else NEW_SHA]
    def test_current_asset_records_actual_bytes(self):
        row = self.asset()
        result = build_manifest(self.base, self.stage, [row], {})
        entry = result["assets"][row[0]]
        self.assertEqual(entry["sha256"], hashlib.sha256(NEW_BYTES).hexdigest())
        self.assertEqual(entry["sourceSha"], NEW_SHA)
        self.assertEqual(entry["sourceTag"], NEW_TAG)
        self.assertEqual(entry["source"], "per-sha")
        self.assertEqual(entry["size"], len(NEW_BYTES))
        self.assertEqual(result["shells"], self.base["shells"])
        self.assertEqual(result["assetSchema"], 1)
    def test_mixed_platforms_keep_independent_provenance(self):
        current = self.asset()
        preserved = self.asset("linux-arm64", OLD_BYTES, True)
        previous = {"assets": {preserved[0]: prior_entry()}}
        result = build_manifest(self.base, self.stage, [current, preserved], previous)
        self.assertEqual(result["assets"][current[0]]["sourceSha"], NEW_SHA)
        self.assertEqual(result["assets"][preserved[0]]["sourceSha"], OLD_SHA)
        self.assertEqual(result["assets"][preserved[0]]["provenance"], "matching-previous-manifest")
    def test_legacy_per_shell_metadata_does_not_establish_provenance(self):
        row = self.asset("linux-arm64", OLD_BYTES, True)
        result = build_manifest(self.base, self.stage, [row], self.base)
        entry = result["assets"][row[0]]
        self.assertIsNone(entry["sourceSha"])
        self.assertIsNone(entry["sourceTag"])
        self.assertEqual(entry["provenance"], "unknown")
        self.assertEqual(entry["sha256"], hashlib.sha256(OLD_BYTES).hexdigest())
    def test_unverified_prior_claims_remain_unknown(self):
        row = self.asset("linux-arm64", OLD_BYTES, True)
        for field, value in [("sha256", "0" * 64), ("size", 12345), ("target", "linux-amd64"),
                             ("shell", "hermes"), ("sourceTag", NEW_TAG), ("sourceSha", None)]:
            with self.subTest(field=field):
                prior = prior_entry()
                prior[field] = value
                result = build_manifest(self.base, self.stage, [row], {"assets": {row[0]: prior}})
                self.assertIsNone(result["assets"][row[0]]["sourceTag"])
    def test_missing_or_malformed_prior_assets_are_safe(self):
        row = self.asset("linux-arm64", OLD_BYTES, True)
        for previous in ({}, {"assets": None}, {"assets": []}, {"assets": {row[0]: "invalid"}}):
            result = build_manifest(self.base, self.stage, [row], previous)
            self.assertEqual(result["assets"][row[0]]["provenance"], "unknown")
    def test_rejects_asserted_new_sha_on_preserved_record(self):
        row = self.asset("linux-arm64", OLD_BYTES, True)
        row[4] = NEW_SHA
        with self.assertRaises(ValueError):
            build_manifest(self.base, self.stage, [row], {})
    def test_rejects_wrong_tag_or_resolved_sha(self):
        row = self.asset()
        for index, value in [(3, OLD_TAG), (4, OLD_SHA)]:
            changed = row.copy()
            changed[index] = value
            with self.assertRaises(ValueError):
                build_manifest(self.base, self.stage, [changed], {})
    def test_rejects_duplicate_traversal_and_unknown_targets(self):
        row = self.asset()
        with self.assertRaises(ValueError):
            build_manifest(self.base, self.stage, [row, row], {})
        for changed in (["../escape", *row[1:]], [row[0], "openclaw", "unknown", *row[3:]], row[:4]):
            with self.assertRaises(ValueError):
                build_manifest(self.base, self.stage, [changed], {})
    def test_rejects_missing_and_unrecorded_assets(self):
        row = self.asset()
        (self.stage / "stale-file").write_bytes(NEW_BYTES)
        with self.assertRaises(ValueError):
            build_manifest(self.base, self.stage, [row], {})
        (self.stage / "stale-file").unlink()
        (self.stage / row[0]).unlink()
        with self.assertRaises(ValueError):
            build_manifest(self.base, self.stage, [row], {})
    def test_rejects_html_and_empty_sets(self):
        row = self.asset(data=b"<!DOCTYPE html>")
        with self.assertRaises(ValueError):
            build_manifest(self.base, self.stage, [row], {})
        with self.assertRaises(ValueError):
            build_manifest(self.base, self.stage, [], {})
    @unittest.skipIf(os.name == "nt", "test uses a Unix symlink")
    def test_rejects_symlink_assets(self):
        row = self.asset()
        (self.stage / row[0]).unlink()
        source = self.stage / ".real"
        source.write_bytes(NEW_BYTES)
        (self.stage / row[0]).symlink_to(source)
        with self.assertRaises(ValueError):
            build_manifest(self.base, self.stage, [row], {})
    def test_header_formats(self):
        for data, kind in [(NEW_BYTES, "elf"), (b"MZ00body", "pe"), (b"\x1f\x8b00body", "gzip"),
                           (b"\xcf\xfa\xed\xfebody", "mach-o")]:
            path = self.stage / ".header"
            path.write_bytes(data)
            self.assertEqual(file_identity(path)[2], kind)
MOCK_GH = r"""#!/usr/bin/env python3
import json, os, pathlib, sys
args=sys.argv[1:]
with open(os.environ['MOCK_GH_LOG'],'a') as log: log.write(json.dumps(args)+'\n')
if args[:2]==['release','download']:
    tag=args[2]
    name=args[args.index('--pattern')+1]
    output=pathlib.Path(args[args.index('--output')+1])
    if tag=='latest' and name=='manifest.json':
        output.write_text(os.environ['MOCK_PREVIOUS'])
    elif tag=='openclaw-aaaaaaaaaaaa' and name=='openclaw-linux-amd64':
        output.write_bytes(b'\x7fELFnew-runtime')
    elif tag=='latest' and name=='openclaw-linux-arm64':
        output.write_bytes(b'\x7fELFold-runtime')
    elif tag=='openclaw-aaaaaaaaaaaa' and name=='openclaw-darwin-arm64':
        output.write_bytes(b'<!DOCTYPE invalid-download>')
    else: sys.exit(1)
    sys.exit(0)
if args[:2] in (['release','view'],['release','delete'],['release','create']): sys.exit(0)
sys.exit(3)
"""
@unittest.skipIf(os.name == "nt" or shutil.which("bash") is None, "release shell runs on Linux")
class WorkflowTests(unittest.TestCase):
    def exercise(self, extra_file=False):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / "scripts").mkdir()
        (root / "bin").mkdir()
        (root / "tmp").mkdir()
        (root / "staging").mkdir()
        for name in ("asset-format.sh", "release_manifest.py"):
            shutil.copyfile(REPO / "scripts" / name, root / "scripts" / name)
        if extra_file:
            (root / "staging" / "unrecorded").write_bytes(NEW_BYTES)
        mock = root / "bin" / "gh"
        mock.write_text(MOCK_GH)
        mock.chmod(0o700)
        text = (REPO / ".github/workflows/build-runtimes.yml").read_text()
        marker = "      - name: Mirror per-SHA assets into a single 'latest' release"
        body = text.split(marker, 1)[1].split("        run: |\n", 1)[1]
        lines = []
        for line in body.splitlines():
            if line and not line.startswith("          "):
                break
            lines.append(line[10:] if line else "")
        script = root / "consolidate.sh"
        script.write_text("\n".join(lines) + "\n")
        env = os.environ.copy()
        env.update(PATH=str(root / "bin") + os.pathsep + env["PATH"],
                   RUNNER_TEMP=str(root / "tmp"), GH_REPO="offline/fixture", GH_TOKEN="not-a-real-token",
                   MOCK_GH_LOG=str(root / "gh.log"),
                   MOCK_PREVIOUS=json.dumps({"assets": {"openclaw-linux-arm64": prior_entry()}}))
        for shell in ("OPENCLAW", "ZEROCLAW", "NANOCLAW", "NEMOCLAW", "MIROFISH", "PICOCLAW", "HERMES", "OPENFANG"):
            env["SHA_" + shell] = NEW_SHA if shell == "OPENCLAW" else ""
        self.assertEqual(shutil.which("gh", path=env["PATH"]), str(mock))
        result = subprocess.run(["bash", str(script)], cwd=root, env=env, capture_output=True, text=True, timeout=20)
        calls = [json.loads(line) for line in (root / "gh.log").read_text().splitlines()]
        return root, result, calls
    def test_actual_workflow_partial_fallback_and_checksums(self):
        root, result, calls = self.exercise()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        manifest = json.loads((root / "staging/manifest.json").read_text())
        self.assertEqual(len(manifest["assets"]), 2)
        self.assertEqual(manifest["assets"]["openclaw-linux-amd64"]["sourceSha"], NEW_SHA)
        self.assertEqual(manifest["assets"]["openclaw-linux-arm64"]["sourceSha"], OLD_SHA)
        self.assertEqual(manifest["shells"]["openclaw"]["sha"], NEW_SHA)
        for line in (root / "staging/SHA256SUMS").read_text().splitlines():
            digest, name = line.split("  ")
            self.assertEqual(hashlib.sha256((root / "staging" / name).read_bytes()).hexdigest(), digest)
        published = [call for call in calls if call[:2] == ["release", "create"]]
        self.assertEqual(len(published), 1)
        self.assertIn("staging/SHA256SUMS", published[0])
        self.assertIn("staging/manifest.json", published[0])
    def test_validation_failure_precedes_release_deletion(self):
        _, result, calls = self.exercise(extra_file=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unrecorded", result.stderr)
        self.assertFalse(any(call[:2] in (["release", "delete"], ["release", "create"]) for call in calls))
if __name__ == "__main__":
    unittest.main()
