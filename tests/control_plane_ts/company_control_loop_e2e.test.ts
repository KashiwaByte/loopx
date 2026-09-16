import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  COMPANY_CONTROL_STATE_RECONCILE_REQUEST_SCHEMA,
  COMPANY_CONTROL_STATE_STORE_REQUEST_SCHEMA,
  loadCompanyControlState,
  planCompanyControlNextCycle,
  reconcileCompanyControlState,
  writeCompanyControlState,
} from "../../loopx/control_plane/work_items/company_control_state.ts";

function state() {
  return {
    schema_version: "company_control_loop_request_v0",
    direction: "Improve durable customer value.",
    cycle: 1,
    outcomes: [{
      outcome_id: "outcome_activation",
      title: "Improve activation",
      metric: "seven day activation rate",
      target: ">= 40%",
      evidence_source: "activation analytics",
    }],
    work_items: [
      {
        work_item_id: "work_ai_delivery",
        outcome_id: "outcome_activation",
        title: "Implement activation instrumentation",
        acceptance: "instrumentation report",
        authority_tier: "A",
        ai_capable: true,
        target_key: "ai_delivery",
      },
      {
        work_item_id: "work_human_decision",
        outcome_id: "outcome_activation",
        title: "Choose the activation threshold",
        acceptance: "recorded threshold decision",
        authority_tier: "B",
        ai_capable: false,
        material_decision: true,
        target_key: "human_decision",
      },
      {
        work_item_id: "work_human_execution",
        outcome_id: "outcome_activation",
        title: "Interview the launch customer",
        acceptance: "customer interview record",
        authority_tier: "C",
        ai_capable: false,
        human_identity_required: true,
        target_key: "human_execution",
      },
    ],
    feedback: [],
  };
}

function storeRequest(runtimeRoot: string, extra: Record<string, unknown>) {
  return {
    schema_version: COMPANY_CONTROL_STATE_STORE_REQUEST_SCHEMA,
    runtime_root: runtimeRoot,
    goal_id: "company-goal",
    ...extra,
  };
}

test("company CEO v0 closes AI, human, restart, escalation, and convergence scenarios", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "loopx-company-e2e-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));

  const first = await writeCompanyControlState(storeRequest(runtimeRoot, {
    state: state(),
    updated_at: "2026-09-17T00:00:00Z",
  }));
  const firstState = first.state as Record<string, any>;
  assert.deepEqual(
    firstState.projection.work_items.map((item: Record<string, unknown>) => item.route),
    ["ai_execute", "human_decide", "human_execute"],
  );

  const restarted = await loadCompanyControlState(storeRequest(runtimeRoot, {}));
  assert.deepEqual(restarted.state, first.state);

  const failedCycle = await reconcileCompanyControlState({
    schema_version: COMPANY_CONTROL_STATE_RECONCILE_REQUEST_SCHEMA,
    runtime_root: runtimeRoot,
    goal_id: "company-goal",
    expected_revision: firstState.revision,
    updated_at: "2026-09-17T00:01:00Z",
    execute: true,
    observations: [
      {
        target_key: "ai_delivery",
        todo_id: "todo_ai_delivery",
        status: "done",
        evidence_ref: "artifact:instrumentation-report",
      },
      {
        target_key: "human_decision",
        todo_id: "todo_human_decision",
        status: "done",
        evidence_ref: "decision:activation-threshold",
      },
      {
        target_key: "human_execution",
        todo_id: "todo_human_execution",
        status: "blocked",
      },
    ],
  });
  const replan = planCompanyControlNextCycle({
    schema_version: "company_control_next_cycle_request_v0",
    goal_id: "company-goal",
    state: failedCycle.state,
  });
  assert.equal(replan.replan_required, true);
  assert.equal(replan.converged_work_item_count, 2);
  assert.equal(replan.remaining_work_item_count, 1);
  const replannedState = replan.state as Record<string, any>;
  assert.equal(replannedState.feedback.at(-1).kind, "risk");
  assert.equal(replannedState.work_items[0].work_item_id, "work_human_execution");

  const second = await writeCompanyControlState(storeRequest(runtimeRoot, {
    state: replannedState,
    expected_revision: (failedCycle.state as Record<string, unknown>).revision,
    updated_at: "2026-09-17T00:02:00Z",
  }));
  const completedCycle = await reconcileCompanyControlState({
    schema_version: COMPANY_CONTROL_STATE_RECONCILE_REQUEST_SCHEMA,
    runtime_root: runtimeRoot,
    goal_id: "company-goal",
    expected_revision: (second.state as Record<string, unknown>).revision,
    updated_at: "2026-09-17T00:03:00Z",
    execute: true,
    observations: [{
      target_key: "human_execution",
      todo_id: "todo_human_execution_retry",
      status: "done",
      evidence_ref: "record:customer-interview",
    }],
  });
  const converged = planCompanyControlNextCycle({
    schema_version: "company_control_next_cycle_request_v0",
    goal_id: "company-goal",
    state: completedCycle.state,
  });
  assert.equal(converged.goal_converged, true);
  assert.equal(converged.remaining_work_item_count, 0);
});
