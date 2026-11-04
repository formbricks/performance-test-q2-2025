// Separate, explicitly approved abuse-protection test; never a capacity result.
import http from "k6/http";
import { Counter } from "k6/metrics";

if (__ENV.CONFIRM_POLICY_TEST !== "I_APPROVE_ARTEMIS_POLICY_TEST" ||
    __ENV.FORMBRICKS_URL !== "https://artemis.app.formbricks.com" ||
    !/^[A-Za-z0-9_-]+$/.test(__ENV.FORMBRICKS_WORKSPACE_ID || "") ||
    !/^eng3309-[A-Za-z0-9._-]+$/.test(__ENV.RUN_ID || "")) {
  throw new Error("policy test requires explicit approval, Artemis URL, workspace and unique run ID");
}
const allowed = new Counter("policy_allowed");
const limited = new Counter("policy_429s");
const unexpected = new Counter("policy_unexpected");
export const options = {
  scenarios: { policy: { executor: "constant-arrival-rate", rate: 3, timeUnit: "1s",
    duration: "2m", preAllocatedVUs: 5, maxVUs: 10 } },
  thresholds: {
    policy_allowed: ["count>0"], policy_429s: ["count>0"],
    policy_unexpected: [{ threshold: "count==0", abortOnFail: true }],
    dropped_iterations: ["count==0"],
  },
};
export default function () {
  const res = http.get(`${__ENV.FORMBRICKS_URL}/api/v1/client/${__ENV.FORMBRICKS_WORKSPACE_ID}/environment`, {
    headers: { "User-Agent": `formbricks-k6-policy/${__ENV.RUN_ID}`, "Accept-Encoding": "gzip" },
    timeout: "10s", tags: { run_id: __ENV.RUN_ID, test_mode: "policy" },
  });
  allowed.add(res.status === 200 ? 1 : 0);
  limited.add(res.status === 429 ? 1 : 0);
  unexpected.add(![200, 429].includes(res.status) ? 1 : 0);
}
