#!/usr/bin/env python3
"""Merge raw request samples; do not infer gateway provenance or maximum capacity."""
import datetime as dt
import json
import math
from pathlib import Path
import sys


def percentile(values, p):
    values = sorted(values)
    position = (len(values) - 1) * p
    lower = math.floor(position)
    upper = math.ceil(position)
    return values[lower] + (values[upper] - values[lower]) * (position - lower)


def report(root):
    root = Path(root)
    manifest = json.loads((root / "manifest.json").read_text())
    execution = json.loads((root / "execution.json").read_text())
    issues = []
    if execution["status"] != "EXECUTED_REQUIRES_REVIEW":
        issues.append("coordinator execution or artifact retrieval incomplete")
    durations = {}
    status_counts = {}
    starts = []
    total_iterations = 0
    dropped = 0
    hold_minutes = [0, 0, 0]
    for index in range(len(manifest["workers"])):
        worker = root / f"worker-{index}"
        try:
            summary = json.loads((worker / "k6-summary.json").read_text())
            if summary["result"] != "PASS":
                issues.append(f"worker {index} thresholds failed")
            start = dt.datetime.fromisoformat((worker / "start.txt").read_text().strip().replace("Z", "+00:00"))
            end = dt.datetime.fromisoformat((worker / "end.txt").read_text().strip().replace("Z", "+00:00"))
            starts.append(start.timestamp())
            if not 300 <= (end - start).total_seconds() <= 345:
                issues.append(f"worker {index} did not complete the expected schedule")
            if not (worker / "cleanup.log").exists() or (worker / "health-abort.txt").exists():
                issues.append(f"worker {index} cleanup evidence missing or health abort present")
            samples = 0
            iterations = 0
            with (worker / "samples.jsonl").open() as stream:
                for line in stream:
                    point = json.loads(line)
                    if point.get("type") != "Point":
                        continue
                    metric, data = point["metric"], point["data"]
                    if metric == "http_req_duration":
                        endpoint = data.get("tags", {}).get("endpoint", "unknown")
                        durations.setdefault(endpoint, []).append(data["value"])
                        status = data.get("tags", {}).get("status", "unknown")
                        status_counts[status] = status_counts.get(status, 0) + 1
                        samples += 1
                    elif metric == "iterations":
                        iterations += data["value"]
                    elif metric == "journeys_started":
                        at = dt.datetime.fromisoformat(data["time"].replace("Z", "+00:00"))
                        elapsed = (at - start).total_seconds()
                        if 60 <= elapsed < 240:
                            hold_minutes[int((elapsed - 60) // 60)] += data["value"]
                    elif metric == "dropped_iterations":
                        dropped += data["value"]
            total_iterations += iterations
            if not samples or not iterations:
                issues.append(f"worker {index} has no request or journey samples")
        except (OSError, ValueError, KeyError) as error:
            issues.append(f"worker {index} missing/invalid evidence: {error}")
    if starts and max(starts) - min(starts) > 2:
        issues.append("worker start skew exceeds 2 seconds")
    if dropped:
        issues.append("dropped iterations")
    if status_counts.get("429", 0):
        issues.append("HTTP 429s invalidate the capacity measurement; correlate Envoy logs")
    # 1->5 ramp (180), hold (900), 5->0 ramp (150). Allow bounded
    # integer scheduling quantization across workers, not missing traffic.
    if abs(total_iterations - 1230) > 2 * len(manifest["workers"]):
        issues.append("achieved journey count differs from the global schedule")
    if any(abs(count - 300) > 2 * len(manifest["workers"]) for count in hold_minutes):
        issues.append("5 journeys/s was not sustained throughout the 3-minute hold")
    return {
        "classification": "INVALID" if issues else "CLIENT_CHECKS_PASSED_REQUIRES_GATEWAY_AND_RESOURCE_REVIEW",
        "issues": issues, "iterations": total_iterations, "dropped_iterations": dropped,
        "http_status_counts": status_counts,
        "hold_journeys_per_minute": hold_minutes,
        "endpoint_latency_ms": {endpoint: {"count": len(values), **{
            f"p{int(p * 100)}": percentile(values, p) for p in (.5, .9, .95, .99)
        }} for endpoint, values in durations.items()},
        "required_manual_evidence": ["Envoy per-IP counts and RL rejection counts",
            "per-pod latency/resources and DB/cache health", "fixture cardinalities and exact cleanup verification"],
    }


if __name__ == "__main__":
    result = report(sys.argv[1])
    print(json.dumps(result, indent=2))
    sys.exit(1 if result["issues"] else 0)
