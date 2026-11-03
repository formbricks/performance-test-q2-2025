// Pure helpers, shared with offline tests. RATE always means GLOBAL journeys/s.
export function capacityConfig(env, profile, scenario, rate) {
  const mode = env.TEST_MODE || "standard";
  if (!["standard", "capacity"].includes(mode)) throw new Error("invalid TEST_MODE");
  if (mode !== "capacity") {
    if (env.WORKER_COUNT || env.WORKER_INDEX) throw new Error("workers require capacity mode");
    return { count: 1, index: 0, timeUnit: "1s" };
  }
  const count = Number(env.WORKER_COUNT);
  const index = Number(env.WORKER_INDEX);
  if (!Number.isInteger(count) || count < 4 || count > 16 ||
      !Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error("capacity requires 4..16 workers and a valid WORKER_INDEX");
  }
  if (profile !== "load" || scenario !== "mixed" || env.DURATION && env.DURATION !== "3m") {
    throw new Error("capacity requires load mixed with a 3m hold");
  }
  // Bound even a temporary 100% client-API mix, not merely its 85% average.
  if (rate * 60 / count > 80) throw new Error("per-IP budget exceeds 80 requests/minute");
  if (env.CAPACITY_COORDINATED !== "1") throw new Error("use the capacity coordinator");
  return { count, index, timeUnit: `${count}s` };
}

export function mixedBucket(iteration, worker = 0) {
  // Coprime permutation preserves exact 60/25/13/2 counts every 100 journeys,
  // without emitting sixty consecutive public-survey journeys.
  return (iteration * 37 + worker * 23) % 100;
}
