"""Offline BookieBot logo inventory, intake, candidate review and publication plans."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

from PIL import Image

SKILL = Path(__file__).resolve().parents[1]
VERSION = 1


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encoded(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def read(path: Path) -> dict:
    return json.loads(path.read_text())


def write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


def stamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def checked_image(path: Path) -> bytes:
    data = path.read_bytes()
    if not data or len(data) > 8_000_000:
        raise ValueError("Empty or oversized image")
    if path.suffix.lower() == ".svg":
        tree = ET.fromstring(data)
        allowed = {"svg", "g", "path", "circle", "ellipse", "rect", "polygon", "polyline", "line",
                   "defs", "lineargradient", "radialgradient", "stop", "clippath", "mask", "title",
                   "desc", "style", "use", "symbol", "text"}
        if tree.tag.split("}")[-1].lower() != "svg":
            raise ValueError("Not an SVG")
        for node in tree.iter():
            if node.tag.split("}")[-1].lower() not in allowed:
                raise ValueError("Active or unsupported SVG element")
            for key, value in node.attrib.items():
                key = key.split("}")[-1].lower()
                if key.startswith("on") or (key == "href" and not value.startswith("#")):
                    raise ValueError("Active or external SVG attribute")
        if re.search(r'<!DOCTYPE|<!ENTITY|@import|javascript:|url\(\s*["\']?(?!#)', data.decode(), re.I):
            raise ValueError("External SVG content")
    else:
        with Image.open(io.BytesIO(data)) as image:
            if image.width > 8192 or image.height > 8192 or image.format not in {"PNG", "JPEG", "WEBP", "ICO"}:
                raise ValueError("Unsupported image")
            image.verify()
    return data


def circle(path: Path) -> bytes:
    data = checked_image(path)
    with Image.open(io.BytesIO(data)) as original:
        if original.format != "PNG" or original.size != (256, 256):
            raise ValueError("A candidate must be a prepared 256px PNG circle")
        image = original.convert("RGBA")
        for y in range(256):
            for x in range(256):
                distance = ((x + .5 - 128) ** 2 + (y + .5 - 128) ** 2) ** .5
                alpha = image.getpixel((x, y))[3]
                if distance > 129 and alpha != 0:
                    raise ValueError("Candidate has an opaque square/backplate outside its circle")
                if distance < 126 and alpha < 250:
                    raise ValueError("Candidate must fill its circle, including behind the mark")
    return data


def inventory(repo: Path) -> dict:
    rows = []
    assets = repo / "src/bookiebot/reports/assets"
    for kind in ("company", "merchant"):
        runtime = json.loads((repo / f"web/expense-report/src/{kind}-logos.json").read_text())
        provenance = read(repo / ("docs/logo-review/audit.json" if kind == "company" else "docs/merchant-logos/catalog.json"))
        provenance = {item["id"]: item for item in provenance["items" if kind == "company" else "logos"]}
        for item in runtime:
            source = provenance[item["id"]]
            path = (assets / item["asset"]).resolve()
            if path.parent != assets.resolve():
                raise ValueError("Catalog asset outside the local asset directory")
            data = checked_image(path)
            if digest(data) != source["sha256"]:
                raise ValueError("Catalog/provenance hash mismatch: " + item["id"])
            row = {
                "key": kind + ":" + item["id"], "kind": kind, "id": item["id"], "name": item["name"],
                "group": source.get("group", "Bills & subscriptions"), "aliases": item["aliases"],
                "asset": str(path.relative_to(repo)), "sha256": digest(data),
                "revision": digest(encoded({"runtime": item, "sha256": digest(data)})),
                "background": "transparent" if kind == "company" else item["background"],
                "inset": 0 if kind == "company" else item["inset"],
                "sourceUrl": source.get("sourceUrl") or source.get("source", ""),
            }
            rows.append(row)
    if len(rows) != len({row["key"] for row in rows}):
        raise ValueError("Duplicate catalog identity")
    return {"kind": "bookiebot-logo-inventory", "version": VERSION, "snapshotId": digest(encoded(rows)), "items": rows}


def batch_item(batch: dict, key: str) -> dict:
    if batch.get("kind") != "bookiebot-logo-batch" or batch.get("version") != VERSION:
        raise ValueError("Unsupported review batch")
    return next(item for item in batch["items"] if item["key"] == key)


def current(repo: Path, item: dict, rows: dict | None = None) -> None:
    rows = rows if rows is not None else {row["key"]: row for row in inventory(repo)["items"]}
    row = rows.get(item["key"])
    if (row or {}).get("revision") != item["expectedRevision"]:
        raise ValueError("Active artwork changed; refresh this review: " + item["key"])


def https(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("References must be public HTTPS URLs")
    return value


def intake(repo: Path, snapshot: dict, feedback: dict) -> dict:
    if (snapshot.get("kind") != "bookiebot-logo-inventory" or snapshot.get("version") != VERSION
            or digest(encoded(snapshot["items"])) != snapshot["snapshotId"]
            or feedback.get("kind") != "bookiebot-logo-feedback" or feedback.get("version") != VERSION
            or feedback.get("snapshotId") != snapshot["snapshotId"]):
        raise ValueError("Feedback does not belong to this inventory")
    source = {row["key"]: row for row in snapshot["items"]}
    active = {row["key"]: row for row in inventory(repo)["items"]}
    normalized = lambda name: re.sub(r"[^\w]+", " ", name.casefold().replace("&", "and")).strip()
    aliases = {normalized(alias) for row in active.values() for alias in [row["name"], *row["aliases"]]}
    items = []
    for choice in feedback.get("items", []):
        if choice["key"] not in source or choice["key"] in {item["key"] for item in items}:
            raise ValueError("Unknown or repeated logo identity")
        row = source[choice["key"]]
        notes = str(choice.get("notes", "")).strip()
        urls = [https(url) for url in choice.get("referenceUrls", [])]
        if len(notes) > 4000 or len(urls) > 5:
            raise ValueError("Split unusually large feedback into a separate batch")
        item = {key: row[key] for key in ("key", "kind", "id", "name")}
        item.update(expectedRevision=row["revision"], current=row, notes=notes, referenceUrls=urls,
                    references=[], candidates=[], status="ready" if choice.get("ready") is True else "needs-input")
        current(repo, item, active)
        items.append(item)
    for name in feedback.get("newRequests", []):
        name = str(name).strip()
        identifier = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        if not name or len(name) > 100 or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", identifier):
            raise ValueError("Give each new merchant a short, explicit name")
        key = "merchant:" + identifier
        if key in source or key in {item["key"] for item in items} or normalized(name) in aliases:
            raise ValueError("Merchant already exists; flag its existing icon: " + name)
        item = dict(key=key, kind="merchant", id=identifier, name=name, expectedRevision=None,
                    current=None, notes="", referenceUrls=[], references=[], candidates=[], status="needs-input")
        current(repo, item, active)
        items.append(item)
    if not items:
        raise ValueError("Flag a logo or request a merchant first")
    return dict(kind="bookiebot-logo-batch", version=VERSION, snapshotId=snapshot["snapshotId"],
                createdAt=stamp(), items=items)


def save_reference(folder: Path, key: str, path: Path) -> dict:
    data = checked_image(path)
    name = key.replace(":", "-") + "-" + digest(data)[:16] + path.suffix.lower()
    destination = folder / "references" / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        destination.write_bytes(data)
    return {"path": str(destination.relative_to(folder)), "sha256": digest(data)}


def stage(repo: Path, batch_path: Path, key: str, prepared: Path, source: Path,
          method: str, prompt: str = "", source_url: str = "", generated: Path | None = None) -> dict:
    batch = read(batch_path)
    item = batch_item(batch, key)
    current(repo, item)
    if item["status"] == "needs-input":
        raise ValueError("Collect references/notes or explicitly mark this item ready before refinement")
    if method not in {"original", "reframe", "ai"}:
        raise ValueError("Unsupported refinement method")
    if method == "ai" and (not prompt.strip() or generated is None):
        raise ValueError("AI candidates require the actual full prompt and original generated output")
    if source_url:
        https(source_url)
    data = circle(prepared)
    reference = save_reference(batch_path.parent, key, source)
    output = save_reference(batch_path.parent, key, generated) if generated is not None else None
    sha = digest(data)
    destination = batch_path.parent / "candidates" / (key.replace(":", "-") + "-" + sha[:16] + ".png")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        destination.write_bytes(data)
    candidate = dict(sha256=sha, asset=str(destination.relative_to(batch_path.parent)),
                     source=reference, sourceUrl=source_url, method=method,
                     tool="built-in image_gen.imagegen" if method == "ai" else "original artwork / deterministic framing",
                     prompt=prompt, generatedOutput=output, createdAt=stamp())
    item["candidates"].append(candidate)
    item["status"] = "candidate-review"
    item.pop("approvedSha256", None)
    write(batch_path, batch)
    return candidate


def approve(repo: Path, batch_path: Path, key: str, sha: str) -> None:
    batch = read(batch_path)
    item = batch_item(batch, key)
    current(repo, item)
    if not item["candidates"] or item["candidates"][-1]["sha256"] != sha:
        raise ValueError("Approval must name the exact latest candidate hash")
    if digest(circle(batch_path.parent / item["candidates"][-1]["asset"])) != sha:
        raise ValueError("Candidate changed after review")
    item.update(status="approved", approvedSha256=sha, approvedAt=stamp())
    write(batch_path, batch)


def promotion_plan(repo: Path, batch_path: Path) -> dict:
    batch = read(batch_path)
    if batch.get("kind") != "bookiebot-logo-batch" or batch.get("version") != VERSION:
        raise ValueError("Unsupported review batch")
    active = {row["key"]: row for row in inventory(repo)["items"]}
    rows = []
    for item in batch["items"]:
        if item["status"] != "approved":
            continue
        current(repo, item, active)
        candidate = item["candidates"][-1]
        if candidate["sha256"] != item["approvedSha256"]:
            raise ValueError("Candidate approval is stale")
        data = circle(batch_path.parent / candidate["asset"])
        if digest(data) != candidate["sha256"]:
            raise ValueError("Candidate changed after approval")
        reference = candidate["source"]
        if digest(checked_image(batch_path.parent / reference["path"])) != reference["sha256"]:
            raise ValueError("Candidate reference changed")
        output = candidate.get("generatedOutput")
        if candidate["method"] == "ai" and (not output or not candidate.get("prompt")):
            raise ValueError("AI provenance is incomplete")
        if output and digest(checked_image(batch_path.parent / output["path"])) != output["sha256"]:
            raise ValueError("Generated output changed")
        prefix = "company-logo-" + ("merchant-" if item["kind"] == "merchant" else "")
        rows.append(dict(key=item["key"], name=item["name"], action="replace" if item["current"] else "add",
                         expectedRevision=item["expectedRevision"], sha256=candidate["sha256"],
                         source=str((batch_path.parent / candidate["asset"]).resolve()),
                         destination="src/bookiebot/reports/assets/" + prefix + item["id"] + "-" + candidate["sha256"][:16] + ".png",
                         catalog=f"web/expense-report/src/{item['kind']}-logos.json",
                         provenance="docs/merchant-logos/catalog.json" if item["kind"] == "merchant" else "docs/logo-review/audit.json",
                         candidate=candidate))
    if not rows:
        raise ValueError("No exact candidates have been approved")
    return {"kind": "bookiebot-logo-promotion-plan", "version": VERSION, "changes": rows,
            "note": "Read-only plan. Preserve aliases and provenance, run the existing catalog gates, then commit/push/merge."}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    commands = parser.add_subparsers(dest="command", required=True)
    inv = commands.add_parser("inventory"); inv.add_argument("--out", type=Path, required=True)
    new = commands.add_parser("intake")
    new.add_argument("--snapshot", type=Path, required=True); new.add_argument("--feedback", type=Path, required=True)
    new.add_argument("--out", type=Path, required=True)
    for command in ("attach", "ready", "stage", "approve", "plan"):
        sub = commands.add_parser(command); sub.add_argument("--batch", type=Path, required=True)
        if command != "plan":
            sub.add_argument("--key", required=True)
        if command == "attach":
            sub.add_argument("--image", type=Path, required=True)
        elif command == "stage":
            sub.add_argument("--prepared", type=Path, required=True); sub.add_argument("--source", type=Path, required=True)
            sub.add_argument("--method", choices=("original", "reframe", "ai"), required=True)
            sub.add_argument("--prompt-file", type=Path); sub.add_argument("--source-url", default="")
            sub.add_argument("--generated", type=Path)
        elif command == "approve":
            sub.add_argument("--sha256", required=True)
        elif command == "plan":
            sub.add_argument("--out", type=Path, required=True)
    gallery = commands.add_parser("gallery")
    gallery.add_argument("--snapshot", type=Path, required=True); gallery.add_argument("--batch", type=Path)
    gallery.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    repo = args.repo.resolve()
    if args.command == "inventory":
        write(args.out, inventory(repo))
    elif args.command == "intake":
        write(args.out, intake(repo, read(args.snapshot), read(args.feedback)))
    elif args.command in {"attach", "ready"}:
        batch = read(args.batch); item = batch_item(batch, args.key); current(repo, item)
        if args.command == "attach":
            item["references"].append(save_reference(args.batch.parent, args.key, args.image))
        else:
            if item["status"] != "needs-input":
                raise ValueError("Only an intake awaiting input can be marked ready")
            item["status"] = "ready"
        write(args.batch, batch)
    elif args.command == "stage":
        print(json.dumps(stage(repo, args.batch, args.key, args.prepared, args.source, args.method,
                               args.prompt_file.read_text() if args.prompt_file else "", args.source_url, args.generated)))
    elif args.command == "approve":
        approve(repo, args.batch, args.key, args.sha256)
    elif args.command == "plan":
        write(args.out, promotion_plan(repo, args.batch))
    elif args.command == "gallery":
        snapshot = read(args.snapshot)
        if args.batch:
            batch = read(args.batch)
            if batch["snapshotId"] != snapshot["snapshotId"]:
                raise ValueError("Batch and inventory do not match")
            rows = []
            for item in batch["items"]:
                row = dict(item["current"] or {key: item[key] for key in ("key", "kind", "id", "name")})
                row.update(notes=item["notes"], referenceUrls=item["referenceUrls"], status=item["status"])
                if item["candidates"]:
                    candidate = item["candidates"][-1]
                    if digest(circle(args.batch.parent / candidate["asset"])) != candidate["sha256"]:
                        raise ValueError("Candidate changed before comparison")
                    row["candidate"] = {**candidate, "asset": str((args.batch.parent / candidate["asset"]).resolve())}
                rows.append(row)
            snapshot = {**snapshot, "items": rows}
        args.out.parent.mkdir(parents=True, exist_ok=True)
        job = args.out.with_suffix(".preview-job.json")
        write(job, {"repo": str(repo), "snapshot": snapshot, "out": str(args.out.resolve()), "template": str(SKILL / "assets/review-board.html")})
        try:
            subprocess.run(["node", str(SKILL / "scripts/gallery.cjs"), str(job)], check=True,
                           env={**os.environ, "BOOKIEBOT_STUDIO_PYTHON": sys.executable})
        finally:
            job.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
