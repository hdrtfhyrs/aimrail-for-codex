"""Accept saved Codex read_thread output/native files and reuse durable import.

No Cloud messages, download, Git or model execution occurs in this program.
--thread-id records the explicit durable target chosen by the calling assistant;
it is provenance, not a cryptographic proof supplied by an arbitrary file.
"""
from __future__ import annotations
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))
import common
import cloud_download as validation

spec = importlib.util.spec_from_file_location("durable_cloud_recovery", Path(__file__).with_name("cloud-recovery.py"))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
INDEX_PREFIX = "IC_NATIVE_INDEX_V1 "
PART_PREFIX = "IC_NATIVE_PART_V1 "
HEADER_PREFIX = "IC_NATIVE_HEADER_V1 "
INDEX_PART_PREFIX = "IC_NATIVE_INDEX_PART_V1 "
FORMAT = "information-center.native-index"


def native_index(value):
    if (value.get("format") != FORMAT or value.get("schema_version") != 1
            or value.get("transport") != "codex_thread_stdout_v1"):
        raise ValueError("unsupported native delivery index")
    # These two legacy fields satisfy the existing *local schema validator*.
    # No repository URL is opened and fetch() is never called.
    compatible = {"format": "information-center.cloud-data-index", "schema_version": 1,
                  "repository": validation.DEFAULT_REPOSITORY, "branch": validation.DEFAULT_BRANCH,
                  "transport": "codex_thread_stdout_v1", "batch": dict(value["batch"])}
    compatible["batch"]["native_delivery"] = True
    batch = validation._validate_index(compatible, validation.DEFAULT_REPOSITORY, validation.DEFAULT_BRANCH)
    if not batch or not batch.get("transfer_chunks"):
        raise ValueError("native index must bind short transfer parts")
    if batch.get("execution") not in {"codex_cloud", "portable", "offline_validation"}:
        raise ValueError("invalid native execution provenance")
    if batch.get("day_status") not in {"success", "partial", "unknown"}:
        raise ValueError("invalid collection health status")
    return compatible


class NativeRecovery(recovery.Recovery):
    def _validate_zip(self, path, batch):
        manifest, digest = super()._validate_zip(path, batch)
        if batch.get("native_delivery") and manifest["origin"]["execution"] != batch["execution"]:
            raise ValueError("native index execution differs from actual public batch")
        return manifest, digest


def offer_native(engine, compatible, available, source):
    """Keep a previously healthy legacy index when redelivering its same ZIP."""
    batch = compatible["batch"]
    original_path = engine.queue / batch["batch_id"] / "index.json"
    if original_path.is_file():
        original = recovery.json_object(recovery.bounded(original_path, 2_000_000))
        original_batch = engine._index(original)
        if original_batch != batch:
            keys = ("batch_id", "bytes", "sha256", "record_count")
            if any(original_batch.get(key) != batch[key] for key in keys):
                raise ValueError("same batch conflicts with original saved public ZIP")
            # New transport can split an existing public ZIP differently. Its
            # original good index and parts stay intact; only a complete newly
            # verified ZIP may fill a missing original artifact.
            fragments = {}
            for number, path in available:
                fragments[number] = validation._chunk_fragment(
                    recovery.bounded(path, 512_000).decode("utf-8"),
                    batch["transfer_chunks"][number], batch["batch_id"], number,
                    len(batch["transfer_chunks"]))
            if len(fragments) < len(batch["transfer_chunks"]):
                return {"batch_id": batch["batch_id"], "status": "awaiting_artifact",
                        "preserved_original_index": True}
            transfer = "".join(fragments[number] for number in range(len(fragments))).encode("utf-8")
            if len(transfer) != batch["transfer_bytes"] or hashlib.sha256(transfer).hexdigest() != batch["transfer_sha256"]:
                raise ValueError("native reassembled transfer changed")
            payload = validation._validate_packet(recovery.json_object(transfer), batch, batch["batch_id"])
            temporary = original_path.parent / ("native-redelivery." + uuid.uuid4().hex + ".zip")
            try:
                recovery.atomic_bytes(temporary, payload)
                engine._validate_zip(temporary, batch)
                result = engine.offer(original, bundle=temporary, source=source)
                return {**result, "preserved_original_index": True}
            finally:
                temporary.unlink(missing_ok=True)
    return engine.offer(compatible, parts=available, source=source)


def envelopes(value, depth=0):
    """Read structured tool JSON and nested text; never extract partial JSON."""
    if depth > 30:
        raise ValueError("input wrapper exceeds nesting limit")
    if isinstance(value, dict):
        if value.get("format") in {FORMAT, "CLOUD_BATCH_TRANSFER_CHUNK_V1", "information-center.native-header", "information-center.native-index-chunk"}:
            yield value
            return
        for nested in value.values():
            yield from envelopes(nested, depth + 1)
    elif isinstance(value, list):
        for nested in value:
            yield from envelopes(nested, depth + 1)
    elif isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith(("{", "[")):
            try:
                nested = json.loads(stripped)
            except ValueError:
                pass
            else:
                yield from envelopes(nested, depth + 1)
                return
        for line in value.splitlines():
            for prefix in (INDEX_PREFIX, PART_PREFIX, HEADER_PREFIX, INDEX_PART_PREFIX):
                if line.startswith(prefix):
                    yield recovery.json_object(line[len(prefix):].encode("utf-8"))


def accept(inputs, *, thread_id, queue=None, import_complete=True):
    if not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", thread_id):
        raise ValueError("explicit Codex thread UUID required")
    engine = NativeRecovery(queue)
    inbox = engine.queue / "native-input"
    source = {"transport": "codex_thread_stdout_v1", "host_id": "durable", "thread_id": thread_id,
              "model_invocations": 0, "network_calls": 0}
    packets, errors, identities = [], [], set()
    for path in inputs:
        try:
            payload = recovery.bounded(path, 100_000_000)
            text = payload.decode("utf-8-sig")
            try:
                value = json.loads(text)
            except ValueError:
                value = text
            count = 0
            for packet in envelopes(value):
                count += 1
                batch_id = packet.get("batch", {}).get("batch_id") if packet.get("format") == FORMAT else packet.get("batch_id")
                if not isinstance(batch_id, str) or not re.fullmatch(r"batch_[a-f0-9]{32}", batch_id):
                    raise ValueError("invalid native batch identity")
                if packet.get("format") == FORMAT:
                    native_index(packet)
                elif packet.get("format") == "information-center.native-header":
                    if (packet.get("schema_version") != 1 or packet.get("transport") != "codex_thread_stdout_v1"
                            or type(packet.get("index_bytes")) is not int or not 1 <= packet["index_bytes"] <= 2_000_000
                            or not re.fullmatch(r"[a-f0-9]{64}", str(packet.get("index_sha256", "")))
                            or type(packet.get("index_part_count")) is not int or not 1 <= packet["index_part_count"] <= 1000
                            or type(packet.get("data_part_count")) is not int or not 1 <= packet["data_part_count"] <= 1000):
                        raise ValueError("invalid native index header")
                    bindings = packet.get("index_parts")
                    if not isinstance(bindings, list) or len(bindings) != packet["index_part_count"]:
                        raise ValueError("header must bind every index shard")
                    for number, binding in enumerate(bindings):
                        if (binding.get("part_index") != number or type(binding.get("bytes")) is not int
                                or not 1 <= binding["bytes"] <= 32_000
                                or not re.fullmatch(r"[a-f0-9]{64}", str(binding.get("sha256", "")))):
                            raise ValueError("invalid bound index shard")
                else:
                    number, total = packet.get("part_index"), packet.get("part_count")
                    fragment = packet.get("payload_utf8")
                    if (type(number) is not int or type(total) is not int or not 0 <= number < total <= 1000
                            or not isinstance(fragment, str) or len(fragment.encode("utf-8")) > 512_000):
                        raise ValueError("invalid native part envelope")
                    if packet.get("format") == "information-center.native-index-chunk" and not re.fullmatch(r"[a-f0-9]{64}", str(packet.get("index_sha256", ""))):
                        raise ValueError("index shard must bind its complete index digest")
                packets.append((batch_id, packet))
                identities.add(batch_id)
            if not count:
                errors.append({"input": str(path), "error": "no complete native envelope; output may be truncated"})
        except (ValueError, OSError, UnicodeError, KeyError, TypeError) as error:
            errors.append({"input": str(path), "error": str(error)[:500]})
    # Retain multiple layouts of the SAME ZIP. Their bound part hashes select
    # a complete layout; a large old index never blocks a valid small layout.
    with engine.lock():
        for batch_id, packet in packets:
            data = json.dumps(packet, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            digest = hashlib.sha256(data).hexdigest()
            kind = packet["format"]
            directory = {FORMAT: "layouts", "CLOUD_BATCH_TRANSFER_CHUNK_V1": "transport-parts",
                         "information-center.native-header": "headers", "information-center.native-index-chunk": "index-parts"}[kind]
            if len(data) > (2_000_000 if kind == FORMAT else 512_000):
                raise ValueError("native cache packet exceeds limit")
            path = inbox / batch_id / directory / (digest + ".json")
            recovery.atomic_bytes(path, data)
    offered = []
    pending = []
    for batch_id in sorted(identities):
        try:
            folder = inbox / batch_id
            candidates = [recovery.json_object(recovery.bounded(path, 2_000_000)) for path in (folder / "layouts").glob("*.json")]
            # Earlier versions' healthy cached artifacts remain usable.
            if (folder / "native-index.json").is_file():
                candidates.append(recovery.json_object(recovery.bounded(folder / "native-index.json", 2_000_000)))
            index_shards = [recovery.json_object(recovery.bounded(path, 512_000)) for path in (folder / "index-parts").glob("*.json")]
            missing_index = []
            for header_path in (folder / "headers").glob("*.json"):
                header = recovery.json_object(recovery.bounded(header_path, 512_000))
                shard_map = {}
                for part in index_shards:
                    number = part["part_index"]
                    if (part.get("index_sha256") != header["index_sha256"]
                            or part.get("part_count") != header["index_part_count"]
                            or number >= header["index_part_count"]):
                        continue
                    binding = header["index_parts"][number]
                    fragment = part["payload_utf8"].encode("utf-8")
                    if len(fragment) == binding["bytes"] and hashlib.sha256(fragment).hexdigest() == binding["sha256"]:
                        shard_map[number] = part
                absent = [n for n in range(header["index_part_count"]) if n not in shard_map]
                if absent:
                    missing_index.append({"index_sha256": header["index_sha256"], "missing": absent})
                    continue
                data = "".join(shard_map[n]["payload_utf8"] for n in range(header["index_part_count"])).encode("utf-8")
                if len(data) != header["index_bytes"] or hashlib.sha256(data).hexdigest() != header["index_sha256"]:
                    raise ValueError("reassembled native index changed or incomplete")
                index = recovery.json_object(data)
                if index.get("batch", {}).get("batch_id") != batch_id:
                    raise ValueError("header and reassembled index identity differ")
                native_index(index)
                candidates.append(index)
                recovery.atomic_bytes(folder / "layouts" / (header["index_sha256"] + ".json"), data)
            if not candidates:
                offered.append({"batch_id": batch_id, "status": "awaiting_index"})
                pending.append({"batch_id": batch_id, "index_parts_missing": missing_index})
                continue
            zip_keys = ("batch_id", "bytes", "sha256", "record_count", "execution")
            first = native_index(candidates[0])["batch"]
            if any(any(native_index(candidate)["batch"].get(key) != first.get(key) for key in zip_keys) for candidate in candidates):
                raise ValueError("same batch has conflicting ZIP identity/provenance across layouts")
            part_paths = [*(folder / "transport-parts").glob("*.json"), *folder.glob("part*.json")]
            part_meta = {}
            for path in part_paths:
                data = recovery.bounded(path, 512_000)
                part_meta[(len(data), hashlib.sha256(data).hexdigest())] = path
            layouts = []
            for candidate in candidates:
                chunks = candidate["batch"]["transfer_chunks"]
                available = [(number, part_meta[(chunk["bytes"], chunk["sha256"])])
                             for number, chunk in enumerate(chunks) if (chunk["bytes"], chunk["sha256"]) in part_meta]
                complete = len(available) == len(chunks)
                layouts.append((complete, len(available), candidate, available))
            layouts.sort(key=lambda item: (item[0], item[1]), reverse=True)
            _, _, index, available = layouts[0]
            compatible = native_index(index)
            bound = compatible["batch"]["transfer_chunks"]
            present = {number for number, _ in available}
            missing = [number for number in range(len(bound)) if number not in present]
            if missing:
                pending.append({"batch_id": batch_id, "parts_missing": missing,
                                "native_windows_missing": sorted({number // 16 for number in missing})})
            offered.append(offer_native(engine, compatible, available, source))
        except (ValueError, OSError, UnicodeError, KeyError, TypeError, validation.DownloadError) as error:
            errors.append({"batch_id": batch_id, "error": str(error)[:500]})
    result = engine.recover() if import_complete else None
    orphan_waiting = any(item.get("status") == "awaiting_index" for item in offered)
    status = "partial" if errors or orphan_waiting or pending or (result and result["status"] != "success") else "success"
    return {"status": status, "transport": source, "offered": offered, "recovery": result,
            "errors": errors, "pending_delivery": pending, "queue": str(engine.queue), "network_calls": 0, "model_invocations": 0}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, action="append", required=True)
    parser.add_argument("--thread-id", required=True)
    parser.add_argument("--queue", type=Path)
    parser.add_argument("--stage-only", action="store_true")
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    result = accept(args.input, thread_id=args.thread_id, queue=args.queue, import_complete=not args.stage_only)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.receipt:
        recovery.atomic_bytes(args.receipt, text.encode("utf-8"))
    print(text)
    raise SystemExit(0 if result["status"] == "success" else 2)


if __name__ == "__main__":
    main()
