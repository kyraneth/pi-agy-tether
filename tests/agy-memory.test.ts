import { expect, it } from "vitest";
import { killDetail, memoryGuardDetail } from "../src/agy-memory.js";

it("guards the measured resident budget or a host with no measured-workload headroom", () => {
  const normalPeakKiB = Math.ceil(443_527_168 / 1024); // measured full scope, not agy alone
  const rssLimitKiB = 8 * 1024 * 1024 - normalPeakKiB;
  expect(memoryGuardDetail(251_520, 34_894_684)).toBeUndefined();
  expect(memoryGuardDetail(rssLimitKiB - 1, normalPeakKiB + 1)).toBeUndefined();
  expect(memoryGuardDetail(rssLimitKiB, undefined)).toMatch(/RSS.*reached/);
  expect(memoryGuardDetail(251_520, normalPeakKiB)).toMatch(/host memory available/);
});

it("reports only substantiated likely OOM on SIGKILL", () => {
  expect(killDetail("SIGKILL", 8_394_956, true)).toMatch(/SIGKILL; last observed RSS 8,394,956 KiB; likely out of memory/);
  expect(killDetail("SIGKILL", 8_394_956)).not.toMatch(/likely out of memory/);
  expect(killDetail("SIGTERM", 8_394_956, true)).not.toMatch(/likely out of memory/);
});
