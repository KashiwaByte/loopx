import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPANY_CONTROL_LOOP_REQUEST_SCHEMA_VERSION,
  projectCompanyControlLoop,
  upgradeCompanyControlLoopState,
} from "../../loopx/control_plane/work_items/company_control_loop.ts";

function request(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: COMPANY_CONTROL_LOOP_REQUEST_SCHEMA_VERSION,
    direction: "Improve durable customer value.",
    cycle: 3,
    outcomes: [{
      outcome_id: "outcome_activation",
      title: "Improve activation",
      metric: "seven day activation rate",
      target: ">= 40%",
      evidence_source: "activation analytics",
    }],
    work_items: [],
    feedback: [],
    ...overrides,
  };
}

function work(overrides: Record<string, unknown> = {}) {
  return {
    work_item_id: "work_activation_analysis",
    outcome_id: "outcome_activation",
    title: "Analyze the activation funnel.",
    acceptance: "Baseline every stage and propose three measurable experiments.",
    authority_tier: "A",
    ai_capable: true,
    target_key: "activation_funnel_analysis",
    ...overrides,
  };
}

test("company control loop routes AI work into an advancement Todo", () => {
  const result = projectCompanyControlLoop(request({ work_items: [work()] }));
  const item = (result.work_items as Record<string, unknown>[])[0];

  assert.equal(result.schema_version, "company_control_loop_v0");
  assert.equal(item.route, "ai_execute");
  assert.equal(item.status, "ready");
  assert.deepEqual(item.todo_projection, {
    role: "agent",
    task_class: "advancement_task",
    action_kind: "ai_execute",
    target_key: "activation_funnel_analysis",
    text: "Analyze the activation funnel.",
    acceptance: "Baseline every stage and propose three measurable experiments.",
  });
});

test("routing precedence preserves authority, waiting, and human boundaries", () => {
  const result = projectCompanyControlLoop(request({
    work_items: [
      work({ work_item_id: "work_rejected", prohibited: true }),
      work({ work_item_id: "work_observe", wait_for: "provider result" }),
      work({ work_item_id: "work_decide", material_decision: true }),
      work({ work_item_id: "work_execute", human_identity_required: true }),
      work({ work_item_id: "work_incomplete", ai_capable: false }),
    ],
  }));

  assert.deepEqual(
    (result.work_items as Record<string, unknown>[]).map((item) => item.route),
    ["reject", "observe", "human_decide", "human_execute", "human_decide"],
  );
  assert.deepEqual(
    (result.work_items as Record<string, unknown>[]).map((item) =>
      (item.todo_projection as Record<string, unknown>).task_class
    ),
    ["blocker", "continuous_monitor", "user_gate", "user_action", "user_gate"],
  );
});

test("material feedback creates an explicit replan signal", () => {
  const result = projectCompanyControlLoop(request({
    feedback: [
      {
        feedback_id: "feedback_metric_change",
        source: "analytics",
        subject: "activation",
        kind: "metric_change",
        observed_at: "2026-09-17T00:00:00Z",
        evidence_ref: "report:activation-2026-09-17",
        affected_outcome_ids: ["outcome_activation"],
      },
      {
        feedback_id: "feedback_comment",
        source: "support",
        subject: "onboarding copy",
        kind: "comment",
        observed_at: "2026-09-17T00:01:00Z",
        evidence_ref: "ticket:123",
        affected_outcome_ids: ["outcome_activation"],
      },
    ],
  }));

  assert.equal(result.replan_required, true);
  assert.deepEqual(
    (result.feedback as Record<string, unknown>[]).map((item) => item.disposition),
    ["replan", "recorded"],
  );
});

test("company control loop rejects dangling outcome references and unsafe ids", () => {
  assert.throws(
    () => projectCompanyControlLoop(request({
      work_items: [work({ outcome_id: "outcome_missing" })],
    })),
    /outcome_id must reference an outcome/,
  );
  assert.throws(
    () => projectCompanyControlLoop(request({
      work_items: [work({ target_key: "../../private" })],
    })),
    /target_key must be a public-safe id/,
  );
});

test("legacy reference state upgrades into the native request contract", () => {
  const legacy = {
    schema_version: "loopx_company_control_state_v0",
    company_direction: "Improve durable customer value.",
    cycle: 2,
    outcomes: request().outcomes,
    work_items: [
      {
        ...work(),
        route: "ai_execute",
        route_reason: "legacy derived value",
        status: "ready",
        evidence_refs: [],
      },
    ],
    feedback: [],
    events: [],
  };
  const result = upgradeCompanyControlLoopState(legacy);
  assert.equal(result.schema_version, "company_control_loop_upgrade_v0");
  assert.equal(result.changed, true);
  assert.deepEqual(result.state, request({ cycle: 2, work_items: [work()] }));
});

test("legacy feedback with ambiguous Goal references fails closed", () => {
  assert.throws(
    () => upgradeCompanyControlLoopState({
      schema_version: "loopx_company_control_state_v0",
      company_direction: "Improve durable customer value.",
      cycle: 1,
      outcomes: request().outcomes,
      work_items: [],
      feedback: [{
        feedback_id: "feedback_legacy",
        source: "operator",
        subject: "activation",
        kind: "decision",
        observed_at: "2026-09-17T00:00:00Z",
        evidence_ref: "decision:42",
        affected_goal_ids: ["goal_company"],
      }],
    }),
    /needs an explicit Outcome mapping/,
  );
});
