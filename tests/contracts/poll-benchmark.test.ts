import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateBenchSamples,
  classifyBenchSample,
  parseTimeLpStderr,
  percentile,
} from "../../scripts/poll-benchmark.js";

describe("poll-benchmark classification", () => {
  it("accepts envelope.ok true with exit 0", () => {
    const s = classifyBenchSample({
      command: "status",
      durationMs: 12,
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, result: { runtime: { state: "ready" } } }),
    });
    assert.equal(s.ok, true);
    assert.equal(s.failureReason, undefined);
    assert.ok(s.stdoutBytes > 0);
  });

  it("fails non-zero exit even with JSON body", () => {
    const s = classifyBenchSample({
      command: "worktree ps",
      durationMs: 9,
      exitCode: 2,
      stdout: JSON.stringify({ ok: true, result: {} }),
    });
    assert.equal(s.ok, false);
    assert.equal(s.failureReason, "non_zero_exit:2");
  });

  it("fails when envelope.ok is not true", () => {
    const s = classifyBenchSample({
      command: "terminal list",
      durationMs: 5,
      exitCode: 0,
      stdout: JSON.stringify({ ok: false, error: { code: "unavailable" } }),
    });
    assert.equal(s.ok, false);
    assert.equal(s.failureReason, "envelope_ok_not_true");
  });

  it("fails invalid JSON and empty stdout", () => {
    assert.equal(
      classifyBenchSample({ command: "status", durationMs: 1, exitCode: 0, stdout: "not-json" }).ok,
      false,
    );
    assert.equal(
      classifyBenchSample({ command: "status", durationMs: 1, exitCode: 0, stdout: "   " })
        .failureReason,
      "empty_stdout",
    );
  });
});

describe("poll-benchmark aggregation", () => {
  it("excludes failures from percentiles and sets ok false", () => {
    const samples = [
      classifyBenchSample({
        command: "status",
        durationMs: 10,
        exitCode: 0,
        stdout: JSON.stringify({ ok: true }),
        cpu: { userSeconds: 0.01, systemSeconds: 0.02, source: "usr_bin_time_lp" },
      }),
      classifyBenchSample({
        command: "status",
        durationMs: 20,
        exitCode: 0,
        stdout: JSON.stringify({ ok: true }),
        cpu: { userSeconds: 0.03, systemSeconds: 0.04, source: "usr_bin_time_lp" },
      }),
      classifyBenchSample({
        command: "status",
        durationMs: 999,
        exitCode: 1,
        stdout: JSON.stringify({ ok: true }),
      }),
      classifyBenchSample({
        command: "status",
        durationMs: 50,
        exitCode: 0,
        stdout: JSON.stringify({ ok: false }),
      }),
      classifyBenchSample({
        command: "worktree ps",
        durationMs: 15,
        exitCode: 0,
        stdout: JSON.stringify({ ok: true }),
      }),
    ];

    const report = aggregateBenchSamples({
      samples,
      iterations: 2,
      cadenceMs: 0,
      measuredAt: "2026-08-01T00:00:00.000Z",
      cpuMeasurement: "usr_bin_time_lp",
    });

    assert.equal(report.ok, false);
    assert.equal(report.totals.failures, 2);
    assert.equal(report.totals.successes, 3);

    const status = report.summary.find((s) => s.command === "status");
    assert.ok(status);
    assert.equal(status!.successCount, 2);
    assert.equal(status!.failureCount, 2);
    assert.deepEqual(status!.durationMs, {
      min: 10,
      p50: percentile([10, 20], 50),
      p95: percentile([10, 20], 95),
      max: 20,
    });
    assert.notEqual(status!.durationMs?.max, 999);
    assert.equal(status!.failures.length, 2);
    assert.ok(status!.cpu);
    assert.equal(status!.cpu!.userSeconds.max, 0.03);

    const ps = report.summary.find((s) => s.command === "worktree ps");
    assert.ok(ps);
    assert.equal(ps!.failureCount, 0);
    assert.equal(ps!.durationMs?.min, 15);
  });

  it("all-success report is ok true with empty failure lists", () => {
    const report = aggregateBenchSamples({
      samples: [
        classifyBenchSample({
          command: "status",
          durationMs: 8,
          exitCode: 0,
          stdout: JSON.stringify({ ok: true }),
        }),
      ],
      iterations: 1,
      cadenceMs: 2000,
      cpuMeasurement: "unavailable",
    });
    assert.equal(report.ok, true);
    assert.equal(report.totals.failures, 0);
    assert.equal(report.summary[0]!.failures.length, 0);
    assert.equal(report.cpuMeasurement, "unavailable");
  });
});

describe("parseTimeLpStderr", () => {
  it("extracts user and sys seconds from time -lp output", () => {
    const cpu = parseTimeLpStderr("real 0.12\nuser 0.04\nsys 0.01\n");
    assert.deepEqual(cpu, {
      userSeconds: 0.04,
      systemSeconds: 0.01,
      source: "usr_bin_time_lp",
    });
  });

  it("returns undefined when markers missing", () => {
    assert.equal(parseTimeLpStderr("nope"), undefined);
  });
});
