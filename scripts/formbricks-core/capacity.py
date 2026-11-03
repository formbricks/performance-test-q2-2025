#!/usr/bin/env python3
"""Supervised SSH workers. No provisioning and no gateway modifications."""
import argparse
import datetime as dt
import ipaddress
import json
import os
from pathlib import Path
import queue
import re
import shlex
import signal
import shutil
import subprocess
import sys
import threading
import time


def validate_manifest(manifest):
    workers = manifest["workers"]
    if not 4 <= len(workers) <= 16:
        raise ValueError("require 4..16 workers")
    if not re.fullmatch(r"[0-9a-f]{40}", manifest["revision"]):
        raise ValueError("pin the full suite commit SHA")
    ips = [str(ipaddress.ip_address(w["envoy_source_ip"])) for w in workers]
    if len(set(ips)) != len(ips):
        raise ValueError("workers share an Envoy-observed source IP")
    for w in workers:
        if not re.fullmatch(r"[A-Za-z0-9_.@-]+", w["host"]) or w["host"].startswith("-"):
            raise ValueError("invalid SSH host")
        for key in ("checkout", "env_file"):
            if not w[key].startswith("/") or "\n" in w[key] or ":" in w[key]:
                raise ValueError("worker paths must be absolute, without newline or colon")
    if not manifest.get("gateway_evidence") or not manifest.get("fixture_cardinality"):
        raise ValueError("record gateway source-IP evidence and fixture cardinality")
    return workers


def stop_group(proc):
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def relay_control(stream, proc):
    try:
        if stream.readline().strip() != "GO":
            return
        proc.stdin.write("GO\n")
        proc.stdin.flush()
        # EOF or any further command means the supervisor stopped/failed.
        stream.readline()
    finally:
        stop_group(proc)


def worker():
    config = json.loads(sys.stdin.readline())
    if not shutil.which("k6"):
        raise ValueError("native k6 is required for supervised cancellation")
    root = Path(config["checkout"])
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip() != config["revision"]:
        raise ValueError("worker revision differs from manifest")
    if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=root):
        raise ValueError("worker checkout has tracked modifications")
    if not re.fullmatch(r"eng3309-[A-Za-z0-9._-]+", config["run_id"]):
        raise ValueError("invalid run ID")
    suite = root / "scripts/formbricks-core"
    run_dir = suite / "report/runs" / config["run_id"]
    if run_dir.exists():
        raise ValueError("refuse to reuse a run directory")
    # The operator-owned file stays on the worker. Never transmit credentials.
    command = 'set -a; source "$1"; set +a; shift; exec env "$@"'
    overrides = {
        "TEST_MODE": "capacity", "CAPACITY_COORDINATED": "1",
        "WORKER_COUNT": str(config["count"]), "WORKER_INDEX": str(config["index"]),
        "RUN_ID": config["run_id"], "RUN_DIR": str(run_dir),
        "RATE": "5", "DURATION": "3m", "MAX_VUS": str(min(20, 200 // config["count"])),
        "FORMBRICKS_URL": "https://artemis.app.formbricks.com",
        "NAMESPACE": "formbricks-artemis", "KUBECTL_CONTEXT": "core-eks",
        "PRE_RUN_SETTLE_SECONDS": "60",
    }
    proc = subprocess.Popen(
        ["bash", "-euc", command, "worker", config["env_file"],
         *[f"{k}={v}" for k, v in overrides.items()], str(suite / "run-full-suite.sh"), "load", "mixed"],
        cwd=root, stdin=subprocess.PIPE, start_new_session=True, text=True,
    )
    threading.Thread(target=relay_control, args=(sys.stdin, proc), daemon=True).start()
    signal.signal(signal.SIGTERM, lambda *_: stop_group(proc))
    signal.signal(signal.SIGINT, lambda *_: stop_group(proc))
    try:
        return proc.wait(timeout=600)
    except subprocess.TimeoutExpired:
        stop_group(proc)
        proc.wait(timeout=60)
        return 1


def coordinate(manifest_path, output, approved):
    manifest = json.loads(Path(manifest_path).read_text())
    workers = validate_manifest(manifest)
    if not approved:
        print("Manifest valid. No connections or load executed. Use --execute-approved for the supervised run.")
        return 0
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    run = "eng3309-capacity-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2))
    events = queue.Queue()
    processes = []
    configs = []
    completed = {}
    ready = set()
    started = None

    def read_output(index, proc):
        with (output / f"worker-{index}.log").open("w") as log:
            for line in proc.stdout:
                log.write(line)
                log.flush()
                if line.strip() == "CAPACITY_READY":
                    events.put(("ready", index, None))
        events.put(("exit", index, proc.wait()))

    try:
        for index, w in enumerate(workers):
            config = dict(w, revision=manifest["revision"], count=len(workers), index=index,
                          run_id=f"{run}-w{index}")
            configs.append(config)
            remote = shlex.join(["python3", f'{w["checkout"]}/scripts/formbricks-core/capacity.py', "worker"])
            proc = subprocess.Popen(["ssh", "-T", "-oBatchMode=yes", "-oConnectTimeout=10",
                                     "-oServerAliveInterval=5", "-oServerAliveCountMax=3", w["host"], remote],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, bufsize=1)
            processes.append(proc)
            proc.stdin.write(json.dumps(config) + "\n")
            proc.stdin.flush()
            threading.Thread(target=read_output, args=(index, proc), daemon=True).start()
        deadline = time.monotonic() + 240
        while len(completed) != len(workers):
            if time.monotonic() > deadline:
                raise RuntimeError("worker readiness or execution timed out")
            try:
                kind, index, code = events.get(timeout=1)
            except queue.Empty:
                continue
            if kind == "exit":
                completed[index] = code
                if code or started is None:
                    raise RuntimeError(f"worker {index} failed or exited before start: {code}")
            else:
                ready.add(index)
                if len(ready) == len(workers) and started is None:
                    started = dt.datetime.now(dt.timezone.utc).isoformat()
                    for proc in processes:
                        proc.stdin.write("GO\n")
                        proc.stdin.flush()
                    deadline = time.monotonic() + 420
    finally:
        # Closing stdin reaches each remote watchdog, including on supervisor crash.
        for proc in processes:
            try:
                proc.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        for proc in processes:
            try:
                proc.wait(timeout=75)
            except subprocess.TimeoutExpired:
                proc.terminate()
        retrieved = []
        for index, config in enumerate(configs):
            remote_dir = f'{config["checkout"]}/scripts/formbricks-core/report/runs/{config["run_id"]}'
            try:
                result = subprocess.run(["scp", "-r", "-oBatchMode=yes", "-oConnectTimeout=10",
                                         f'{config["host"]}:{remote_dir}', str(output / f"worker-{index}")],
                                        timeout=60, capture_output=True)
                retrieved.append(result.returncode == 0)
            except subprocess.TimeoutExpired:
                retrieved.append(False)
        (output / "execution.json").write_text(json.dumps({
            "run_id": run, "started": started, "worker_exits": completed,
            "artifacts_retrieved": retrieved,
            "status": "EXECUTED_REQUIRES_REVIEW" if len(completed) == len(workers) and
                all(v == 0 for v in completed.values()) and all(retrieved) else "INCOMPLETE",
        }, indent=2))
    return 0 if len(retrieved) == len(workers) and all(retrieved) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["worker", "run"])
    parser.add_argument("--manifest")
    parser.add_argument("--output")
    parser.add_argument("--execute-approved", action="store_true")
    args = parser.parse_args()
    if args.command == "run" and (not args.manifest or not args.output):
        parser.error("run requires --manifest and --output")
    try:
        sys.exit(worker() if args.command == "worker" else coordinate(args.manifest, args.output, args.execute_approved))
    except (ValueError, RuntimeError, KeyboardInterrupt) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
