// Accelerated integration fixture: reuse the real workload and thresholds,
// but never permit this shortened schedule to target a remote service.
import { options as actualOptions, mixedWorkload, handleSummary } from "../k6/formbricks-core.js";
if (__ENV.FORMBRICKS_URL !== "http://127.0.0.1:18080") {
  throw new Error("accelerated fixture is localhost-only");
}
export { mixedWorkload, handleSummary };
export const options = {
  ...actualOptions,
  scenarios: {
    mixed: {
      ...actualOptions.scenarios.mixed,
      timeUnit: "80ms",
      stages: [{ target: 5, duration: "2s" }, { target: 5, duration: "6s" }, { target: 0, duration: "2s" }],
    },
  },
};
