"""Public batch delivery through Codex native files/tool stdout; no network/Git."""
from __future__ import annotations
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import uuid
import zipfile

INDEX_PREFIX = "IC_NATIVE_INDEX_V1 "
PART_PREFIX = "IC_NATIVE_PART_V1 "
HEADER_PREFIX = "IC_NATIVE_HEADER_V1 "
INDEX_PART_PREFIX = "IC_NATIVE_INDEX_PART_V1 "
INDEX_FORMAT = "information-center.native-index"
TRANSPORT = "codex_thread_stdout_v1"
MAX_ZIP = 64_000_000
DEFAULT_FRAGMENT_SIZE = 8_000
MAX_STDOUT_CHARS = 16_000  # Headroom below actual read_thread per-item max 20000.
WINDOW_PARTS = 16


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def bounded_output(text):
    if len(text) > MAX_STDOUT_CHARS:
        raise ValueError("output exceeds native read limit; rebuild with fragment_size=8000 in a new destination")
    return text


def index_header(index):
    text = compact(index)
    fragments = [text[i:i + DEFAULT_FRAGMENT_SIZE] for i in range(0, len(text), DEFAULT_FRAGMENT_SIZE)]
    payload = text.encode("utf-8")
    return {"format": "information-center.native-header", "schema_version": 1,
            "transport": TRANSPORT, "batch_id": index["batch"]["batch_id"],
            "index_bytes": len(payload), "index_sha256": hashlib.sha256(payload).hexdigest(),
            "index_part_count": len(fragments), "data_part_count": len(index["batch"]["transfer_chunks"]),
            "index_parts": [{"part_index": number, "bytes": len(fragment.encode("utf-8")),
                             "sha256": hashlib.sha256(fragment.encode("utf-8")).hexdigest()}
                            for number, fragment in enumerate(fragments)],
            "window_parts": WINDOW_PARTS}, fragments


def build(bundle, destination, *, day_status="unknown", fragment_size=DEFAULT_FRAGMENT_SIZE):
    bundle, destination = Path(bundle), Path(destination)
    if bundle.is_symlink() or not bundle.is_file() or not 1 <= bundle.stat().st_size <= MAX_ZIP:
        raise ValueError("invalid public batch ZIP")
    if not 4_000 <= fragment_size <= DEFAULT_FRAGMENT_SIZE:
        raise ValueError("fragment_size must be 4000..8000 for the actual native read limit")
    payload = bundle.read_bytes()
    with zipfile.ZipFile(bundle) as archive:
        if len(archive.infolist()) != 2 or set(archive.namelist()) != {"manifest.json", "articles.jsonl"}:
            raise ValueError("public batch must contain only manifest and articles")
        if archive.getinfo("manifest.json").file_size > 2_000_000:
            raise ValueError("oversized manifest")
        manifest = json.loads(archive.read("manifest.json"))
    batch_id = manifest["batch_id"]
    if not re.fullmatch(r"batch_[a-f0-9]{32}", batch_id):
        raise ValueError("invalid batch identity")
    if manifest.get("format") != "information-center.batch" or manifest.get("schema_version") != 1:
        raise ValueError("invalid batch schema")
    origin = manifest.get("origin", {})
    if origin.get("collector") != "codex-cloud-public-collector" or origin.get("execution") not in {"codex_cloud", "portable", "offline_validation"}:
        raise ValueError("invalid execution provenance")
    digest = hashlib.sha256(payload).hexdigest()
    folder = destination / batch_id
    if folder.is_symlink():
        raise ValueError("symlinked delivery folder")
    index_path = folder / "index.json"
    if index_path.exists():
        index = json.loads(index_path.read_text(encoding="utf-8"))
        if index.get("format") != INDEX_FORMAT or index["batch"]["sha256"] != digest:
            raise ValueError("same batch has a different delivery")
        # Repair missing generated files using the original fragment size.
        fragment_size = index["fragment_size"]
        if fragment_size > DEFAULT_FRAGMENT_SIZE:
            raise ValueError("preserve old large delivery; rebuild into a new destination for native reads")
    packet = {"format": "CLOUD_BATCH_TRANSFER_V1", "encoding": "base64", "batch_id": batch_id,
              "file_name": batch_id + ".zip", "zip_bytes": len(payload), "zip_sha256": digest,
              "payload_base64": base64.b64encode(payload).decode("ascii")}
    transfer = compact(packet)
    fragments = [transfer[i:i + fragment_size] for i in range(0, len(transfer), fragment_size)]
    if len(fragments) > 1000:
        raise ValueError("batch exceeds existing receiver's 1000-part bound; keep the ZIP for a shorter export")
    chunks = []
    for number, fragment in enumerate(fragments):
        part = {"format": "CLOUD_BATCH_TRANSFER_CHUNK_V1", "batch_id": batch_id,
                "part_index": number, "part_count": len(fragments), "payload_utf8": fragment}
        data = compact(part).encode("utf-8")
        bounded_output(PART_PREFIX + data.decode("utf-8"))
        name = f"{batch_id}.transfer.part{number:03d}.json"
        atomic(folder / name, data)
        chunks.append({"path": "batches/" + name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    transfer_bytes = transfer.encode("utf-8")
    index = {"format": INDEX_FORMAT, "schema_version": 1, "transport": TRANSPORT,
             "fragment_size": fragment_size, "batch": {"batch_id": batch_id,
             "path": f"batches/{batch_id}.zip", "bytes": len(payload), "sha256": digest,
             "transfer_path": f"batches/{batch_id}.transfer.json", "transfer_bytes": len(transfer_bytes),
             "transfer_sha256": hashlib.sha256(transfer_bytes).hexdigest(), "transfer_chunks": chunks,
             "record_count": manifest["record_count"], "execution": origin["execution"],
             "created_at": manifest["created_at"], "collected_at": manifest["collected_at"],
             "day_status": day_status}}
    if index_path.exists():
        original = json.loads(index_path.read_text(encoding="utf-8"))
        # Preserve collection health/provenance on same-day retransmission.
        index["batch"]["day_status"] = original["batch"]["day_status"]
        if index != original:
            raise ValueError("existing delivery index differs; preserve original")
    atomic(folder / (batch_id + ".zip"), payload)
    atomic(folder / (batch_id + ".transfer.json"), transfer_bytes)
    atomic(index_path, compact(index).encode("utf-8"))
    return index_path, index


def emit(index_path, part=None, index_part=None):
    index_path = Path(index_path)
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if index.get("format") != INDEX_FORMAT or index.get("transport") != TRANSPORT:
        raise ValueError("native delivery index required")
    if part is None:
        header, fragments = index_header(index)
        if index_part is not None:
            if not 0 <= index_part < len(fragments):
                raise ValueError("index part outside header")
            packet = {"format": "information-center.native-index-chunk", "batch_id": header["batch_id"],
                      "index_sha256": header["index_sha256"], "part_index": index_part,
                      "part_count": len(fragments), "payload_utf8": fragments[index_part]}
            return bounded_output(INDEX_PART_PREFIX + compact(packet))
        direct = INDEX_PREFIX + compact(index)
        return bounded_output(direct if len(direct) <= MAX_STDOUT_CHARS else HEADER_PREFIX + compact(header))
    chunks = index["batch"]["transfer_chunks"]
    if not 0 <= part < len(chunks):
        raise ValueError("part number outside index")
    chunk = chunks[part]
    path = index_path.parent / Path(chunk["path"]).name
    data = path.read_bytes()
    if len(data) != chunk["bytes"] or hashlib.sha256(data).hexdigest() != chunk["sha256"]:
        raise ValueError("saved part changed or was truncated")
    return bounded_output(PART_PREFIX + data.decode("utf-8"))


def window_files(index_path, destination=None):
    """Native files below 256KB; no model turns or network scheduling."""
    index_path = Path(index_path)
    index = json.loads(index_path.read_text(encoding="utf-8"))
    header, fragments = index_header(index)
    count = header["data_part_count"]
    destination = Path(destination) if destination else index_path.parent / "windows"
    prefix = [emit(index_path)]
    if prefix[0].startswith(HEADER_PREFIX):
        prefix += [emit(index_path, index_part=n) for n in range(len(fragments))]
    files = []
    for number, start in enumerate(range(0, count, WINDOW_PARTS)):
        stop = min(start + WINDOW_PARTS, count)
        data = ("\n".join(prefix + [emit(index_path, n) for n in range(start, stop)]) + "\n").encode("utf-8")
        if len(data) > 256_000:
            raise ValueError("window file exceeds bounded native-file size")
        path = destination / f"window{number:03d}.txt"
        atomic(path, data)
        files.append({"number": number, "path": str(path), "first_part": start, "last_part": stop - 1,
                      "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("build")
    create.add_argument("--bundle", type=Path, required=True)
    create.add_argument("--destination", type=Path, required=True)
    create.add_argument("--day-status", default="unknown")
    create.add_argument("--fragment-size", type=int, default=DEFAULT_FRAGMENT_SIZE)
    output = sub.add_parser("emit")
    output.add_argument("--index", type=Path, required=True)
    output.add_argument("--part", type=int)
    output.add_argument("--index-part", type=int)
    windows = sub.add_parser("windows")
    windows.add_argument("--index", type=Path, required=True)
    windows.add_argument("--destination", type=Path)
    args = parser.parse_args()
    if args.command == "build":
        path, index = build(args.bundle, args.destination, day_status=args.day_status, fragment_size=args.fragment_size)
        print(emit(path))
        header, _ = index_header(index)
        print(compact({"index_file": str(path), "part_count": header["data_part_count"],
                       "index_part_count": header["index_part_count"], "max_stdout_chars": MAX_STDOUT_CHARS}))
    elif args.command == "windows":
        print(compact({"files": window_files(args.index, args.destination), "max_parts_in_stdout_turn": WINDOW_PARTS}))
    else:
        if args.part is not None and args.index_part is not None:
            parser.error("choose data part OR index part")
        print(emit(args.index, args.part, args.index_part))


if __name__ == "__main__":
    main()
