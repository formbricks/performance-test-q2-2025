import assert from "node:assert/strict";
import test from "node:test";
import { capacityConfig, mixedBucket } from "../k6/lib/capacity.js";

test("mixed journeys are interleaved and preserve counts per worker", () => {
  for (let worker = 0; worker < 16; worker++) {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 100; i++) {
      const b = mixedBucket(i, worker);
      counts[b < 60 ? 0 : b < 85 ? 1 : b < 98 ? 2 : 3]++;
    }
    assert.deepEqual(counts, [60, 25, 13, 2]);
  }
});

test("capacity divides the global schedule and enforces worst-case IP budget", () => {
  const env = { TEST_MODE: "capacity", WORKER_COUNT: "4", WORKER_INDEX: "0", CAPACITY_COORDINATED: "1" };
  assert.equal(capacityConfig(env, "load", "mixed", 5).timeUnit, "4s");
  assert.throws(() => capacityConfig(env, "load", "mixed", 6), /budget/);
  assert.throws(() => capacityConfig({ ...env, WORKER_COUNT: "3" }, "load", "mixed", 5));
  assert.throws(() => capacityConfig({ ...env, WORKER_INDEX: "4" }, "load", "mixed", 5));
  assert.throws(() => capacityConfig({ ...env, CAPACITY_COORDINATED: "0" }, "load", "mixed", 5));
  assert.throws(() => capacityConfig(env, "baseline", "mixed", 5));
});
