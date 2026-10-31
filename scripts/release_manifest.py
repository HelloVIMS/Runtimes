#!/usr/bin/env python3
"""Record the bytes actually staged for a rolling release, not just resolved HEADs.
No downloads or release mutations occur here. A preserved asset inherits a source
commit/tag only when the previous per-asset manifest describes the exact same
bytes. Legacy per-shell metadata is not sufficient evidence of provenance.
"""
from __future__ import annotations
import argparse
import csv
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any
TARGETS = {"darwin-arm64", "darwin-amd64", "linux-amd64", "linux-arm64", "windows-amd64"}
SHA = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
SHELL = re.compile(r"[a-z][a-z0-9-]*\Z")
def file_identity(path: Path) -> tuple[str, int, str]:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"asset is not a regular, non-symlink file: {path.name}")
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        magic = source.read(4)
        digest.update(magic)
        size += len(magic)
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            size += len(chunk)
            digest.update(chunk)
    if magic == b"\x7fELF":
        kind = "elf"
    elif magic in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xfe\xed\xfa\xce", b"\xca\xfe\xba\xbe"):
        kind = "mach-o"
    elif magic.startswith(b"MZ"):
        kind = "pe"
    elif magic.startswith(b"\x1f\x8b"):
        kind = "gzip"
    else:
        raise ValueError(f"asset has an unrecognized executable/archive header: {path.name}")
    return digest.hexdigest(), size, kind
def valid_source(shell: str, tag: Any, sha: Any) -> bool:
    return isinstance(sha, str) and SHA.fullmatch(sha) is not None and tag == f"{shell}-{sha[:12]}"
def build_manifest(base: dict[str, Any], staging: Path, origins: list[list[str]], previous: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(base.get("shells"), dict):
        raise ValueError("base manifest must contain shells")
    assets: dict[str, Any] = {}
    previous_assets = previous.get("assets", {})
    if not isinstance(previous_assets, dict):
        previous_assets = {}
    for row in origins:
        if len(row) != 5:
            raise ValueError("each origin needs asset, shell, target, source tag, source SHA")
        name, shell, target, tag, sha = row
        if not SHELL.fullmatch(shell) or shell not in base["shells"] or target not in TARGETS:
            raise ValueError("unknown runtime or target in origin record")
        expected = f"{shell}-{target}" + (".exe" if target == "windows-amd64" else "")
        if name != expected or Path(name).name != name or name in assets:
            raise ValueError(f"invalid or duplicate asset name: {name}")
        digest, size, kind = file_identity(staging / name)
        entry: dict[str, Any] = {
            "shell": shell, "target": target, "sha256": digest, "size": size,
            "format": kind, "sourceTag": None, "sourceSha": None,
        }
        if tag == "previous-latest":
            if sha != "-":
                raise ValueError("a previous-latest record cannot assert the newly resolved SHA")
            entry.update(source="previous-latest", provenance="unknown")
            prior = previous_assets.get(name)
            if (isinstance(prior, dict) and prior.get("sha256") == digest
                and prior.get("size") == size and prior.get("shell") == shell
                and prior.get("target") == target
                and valid_source(shell, prior.get("sourceTag"), prior.get("sourceSha"))):
                entry.update(sourceTag=prior["sourceTag"], sourceSha=prior["sourceSha"], provenance="matching-previous-manifest")
        else:
            if not valid_source(shell, tag, sha):
                raise ValueError(f"tag and upstream SHA disagree for {name}")
            resolved = base["shells"][shell]
            if not isinstance(resolved, dict) or resolved.get("sha") != sha or resolved.get("tag") != tag:
                raise ValueError(f"per-SHA origin disagrees with resolved metadata for {name}")
            entry.update(source="per-sha", sourceTag=tag, sourceSha=sha, provenance="release-tag")
        assets[name] = entry
    if not assets:
        raise ValueError("refusing an empty runtime manifest")
    # Do not publish leftover/unrecorded files through the workflow's staging/*.
    actual = {p.name for p in staging.iterdir() if not p.name.startswith(".") and p.name not in {"manifest.json", "SHA256SUMS"}}
    if actual != set(assets):
        raise ValueError("staging contains missing or unrecorded assets")
    return {**base, "assetSchema": 1, "assets": assets}
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staging", required=True, type=Path)
    parser.add_argument("--origins", required=True, type=Path)
    parser.add_argument("--previous", type=Path)
    args = parser.parse_args()
    manifest_path = args.staging / "manifest.json"
    base = json.loads(manifest_path.read_text(encoding="utf-8"))
    previous: dict[str, Any] = {}
    if args.previous:
        try:
            candidate = json.loads(args.previous.read_text(encoding="utf-8"))
            if isinstance(candidate, dict):
                previous = candidate
        except (OSError, ValueError):
            print("Previous manifest unavailable/invalid; preserved provenance will remain unknown", file=sys.stderr)
    with args.origins.open(encoding="utf-8", newline="") as source:
        origins = list(csv.reader(source, delimiter="\t"))
    result = build_manifest(base, args.staging, origins, previous)
    manifest_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    sums = {name: item["sha256"] for name, item in result["assets"].items()}
    sums["manifest.json"] = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    (args.staging / "SHA256SUMS").write_text("".join(f"{digest}  {name}\n" for name, digest in sorted(sums.items())), encoding="utf-8")
    print(f"Recorded checksums and per-asset provenance for {len(result['assets'])} runtime files")
if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError) as error:
        print(f"release manifest: {error}", file=sys.stderr)
        raise SystemExit(1)
