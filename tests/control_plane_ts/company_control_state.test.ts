import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  COMPANY_CONTROL_STATE_STORE_REQUEST_SCHEMA,
  companyControlStatePath,
  loadCompanyControlState,
  writeCompanyControlState,
} from "../../loopx/control_plane/work_items/company_control_state.ts";

function state(direction = "Improve durable customer value.") {
  return {
    schema_version: "company_control_loop_request_v0",
    direction,
    cycle: 1,
    outcomes: [{
      outcome_id: "outcome_activation",
      title: "Improve activation",
      metric: "seven day activation rate",
      target: ">= 40%",
      evidence_source: "activation analytics",
    }],
    work_items: [],
    feedback: [],
  };
}

function request(runtimeRoot: string, extra: Record<string, unknown> = {}) {
  return {
    schema_version: COMPANY_CONTROL_STATE_STORE_REQUEST_SCHEMA,
    runtime_root: runtimeRoot,
    goal_id: "company-goal",
    ...extra,
  };
}

test("company control state writes atomically and reads back exact revision", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "loopx-company-state-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));

  const first = await writeCompanyControlState(request(runtimeRoot, {
    state: state(),
    updated_at: "2026-09-17T00:00:00Z",
  }));
  assert.equal(first.written, true);
  const stored = first.state as Record<string, unknown>;
  assert.match(String(stored.revision), /^[a-f0-9]{64}$/);

  const loaded = await loadCompanyControlState(request(runtimeRoot));
  assert.deepEqual(loaded.state, first.state);
  assert.equal(loaded.path, companyControlStatePath(runtimeRoot, "company-goal"));

  const replay = await writeCompanyControlState(request(runtimeRoot, {
    state: state(),
    updated_at: "2026-09-17T00:01:00Z",
  }));
  assert.equal(replay.written, false);
  assert.equal(replay.replayed, true);
});

test("company control state requires revision matching for updates", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "loopx-company-state-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const first = await writeCompanyControlState(request(runtimeRoot, {
    state: state(),
    updated_at: "2026-09-17T00:00:00Z",
  }));
  const stored = first.state as Record<string, unknown>;

  await assert.rejects(
    writeCompanyControlState(request(runtimeRoot, {
      state: state("Changed direction."),
      updated_at: "2026-09-17T00:01:00Z",
    })),
    /expected_revision is required/,
  );
  await assert.rejects(
    writeCompanyControlState(request(runtimeRoot, {
      state: state("Changed direction."),
      expected_revision: "0".repeat(64),
      updated_at: "2026-09-17T00:01:00Z",
    })),
    /revision changed/,
  );
  const updated = await writeCompanyControlState(request(runtimeRoot, {
    state: state("Changed direction."),
    expected_revision: stored.revision,
    updated_at: "2026-09-17T00:01:00Z",
  }));
  assert.equal(updated.written, true);
  assert.notEqual(
    (updated.state as Record<string, unknown>).revision,
    stored.revision,
  );
});

test("company control state path is bounded and rejects relative runtime roots", () => {
  const left = companyControlStatePath("/runtime", "company goal");
  const right = companyControlStatePath("/runtime", "company-goal");
  assert.notEqual(left, right);
  assert.match(left, /company-control-loop\/state\.json$/);
  assert.throws(
    () => companyControlStatePath("relative", "company-goal"),
    /runtime_root must be absolute/,
  );
});
