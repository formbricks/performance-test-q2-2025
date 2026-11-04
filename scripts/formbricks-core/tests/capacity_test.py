import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


capacity = load("capacity", "capacity.py")
reporter = load("reporter", "capacity-report.py")


class CapacityTests(unittest.TestCase):
    def manifest(self):
        return {"revision": "a" * 40, "gateway_evidence": "approved log evidence reference",
                "fixture_cardinality": {"surveys_per_worker": 1},
                "workers": [{"host": f"worker-{i}", "checkout": "/srv/performance",
                             "env_file": "/run/secrets/performance.env", "envoy_source_ip": f"192.0.2.{i+1}"}
                            for i in range(4)]}

    def test_manifest_rejects_shared_nat_and_bad_paths(self):
        manifest = self.manifest()
        self.assertEqual(len(capacity.validate_manifest(manifest)), 4)
        manifest["workers"][1]["envoy_source_ip"] = "192.0.2.1"
        with self.assertRaises(ValueError):
            capacity.validate_manifest(manifest)
        manifest = self.manifest()
        manifest["workers"][0]["host"] = "-oProxyCommand=evil"
        with self.assertRaises(ValueError):
            capacity.validate_manifest(manifest)

    def test_validate_only_never_launches_a_process(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text(json.dumps(self.manifest()))
            with patch.object(capacity.subprocess, "Popen") as popen:
                self.assertEqual(capacity.coordinate(path, Path(directory) / "out", False), 0)
                popen.assert_not_called()

    def test_percentiles_use_combined_samples(self):
        self.assertEqual(reporter.percentile([1, 2, 3, 100], .5), 2.5)
        self.assertAlmostEqual(reporter.percentile([1, 2, 3, 100], .95), 85.45)

    def test_disconnect_stops_remote_process_group(self):
        for control in ("", "STOP\n", "GO\n"):
            proc = Mock(pid=123)
            proc.poll.return_value = None
            proc.stdin = io.StringIO()
            with patch.object(capacity.os, "killpg") as kill:
                capacity.relay_control(io.StringIO(control), proc)
                kill.assert_called_once_with(123, capacity.signal.SIGTERM)
            self.assertEqual(proc.stdin.getvalue(), "GO\n" if control == "GO\n" else "")

    def test_complete_samples_merge_and_429_invalidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "manifest.json").write_text(json.dumps(self.manifest()))
            (root / "execution.json").write_text(json.dumps({"status": "EXECUTED_REQUIRES_REVIEW"}))
            for index in range(4):
                worker = root / f"worker-{index}"
                worker.mkdir()
                (worker / "k6-summary.json").write_text(json.dumps({"result": "PASS"}))
                (worker / "start.txt").write_text("2026-01-01T00:00:00Z")
                (worker / "end.txt").write_text("2026-01-01T00:05:00Z")
                (worker / "cleanup.log").write_text("fixture cleanup evidence")
                points = [
                    {"type": "Point", "metric": "http_req_duration", "data": {
                        "value": 10 * (index + 1), "tags": {"endpoint": "public_environment", "status": "200"}}},
                    {"type": "Point", "metric": "iterations", "data": {"value": 308 if index < 2 else 307}},
                    *[{"type": "Point", "metric": "journeys_started", "data": {
                        "value": 75, "time": f"2026-01-01T00:0{minute}:10Z"}} for minute in (1, 2, 3)],
                ]
                (worker / "samples.jsonl").write_text("\n".join(json.dumps(p) for p in points))
            result = reporter.report(root)
            self.assertEqual(result["issues"], [])
            self.assertEqual(result["hold_journeys_per_minute"], [300, 300, 300])
            self.assertEqual(result["endpoint_latency_ms"]["public_environment"]["p50"], 25)
            path = root / "worker-0/samples.jsonl"
            path.write_text(path.read_text().replace('"200"', '"429"'))
            self.assertEqual(reporter.report(root)["classification"], "INVALID")

    def test_missing_worker_evidence_never_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "manifest.json").write_text(json.dumps(self.manifest()))
            (root / "execution.json").write_text(json.dumps({"status": "INCOMPLETE"}))
            result = reporter.report(root)
            self.assertEqual(result["classification"], "INVALID")
            self.assertGreaterEqual(len(result["issues"]), 5)

    def test_worker_failure_closes_all_control_channels(self):
        class FakeProcess:
            def __init__(self, failed):
                self.stdin = io.StringIO()
                self.stdout = io.StringIO("" if failed else "CAPACITY_READY\n")
                self.code = 1 if failed else 0
            def wait(self, timeout=None):
                return self.code
        processes = [FakeProcess(i == 0) for i in range(4)]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "manifest.json").write_text(json.dumps(self.manifest()))
            with patch.object(capacity.subprocess, "Popen", side_effect=processes), \
                 patch.object(capacity.subprocess, "run") as scp:
                scp.return_value.returncode = 1
                with self.assertRaises(RuntimeError):
                    capacity.coordinate(root / "manifest.json", root / "out", True)
            self.assertTrue(all(p.stdin.closed for p in processes))
            state = json.loads((root / "out/execution.json").read_text())
            self.assertEqual(state["status"], "INCOMPLETE")


if __name__ == "__main__":
    unittest.main()
