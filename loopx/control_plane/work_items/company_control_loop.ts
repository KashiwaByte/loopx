import { EffectRuntimeRequestError } from "../effect_runtime_errors.ts";
import {
  optionalNonEmptyString,
  requireBoolean,
  requireInteger,
  requireJsonObject,
  requireNonEmptyString,
  requireStringArray,
  requireStringLiteral,
} from "../runtime_decode.ts";

import type { JsonObject } from "../effect_program.ts";

export const COMPANY_CONTROL_LOOP_REQUEST_SCHEMA_VERSION =
  "company_control_loop_request_v0";
export const COMPANY_CONTROL_LOOP_SCHEMA_VERSION = "company_control_loop_v0";
export const COMPANY_CONTROL_LOOP_UPGRADE_SCHEMA_VERSION =
  "company_control_loop_upgrade_v0";
export const LEGACY_COMPANY_CONTROL_STATE_SCHEMA_VERSION =
  "loopx_company_control_state_v0";

const MAX_OUTCOMES = 128;
const MAX_WORK_ITEMS = 256;
const MAX_FEEDBACK_ITEMS = 256;
const PUBLIC_ID = /^[a-z][a-z0-9_-]{2,127}$/;

export const COMPANY_WORK_ROUTES = [
  "ai_execute",
  "human_decide",
  "human_execute",
  "observe",
  "reject",
] as const;

export type CompanyWorkRoute = (typeof COMPANY_WORK_ROUTES)[number];
export type CompanyAuthorityTier = "A" | "B" | "C" | "D";

interface CompanyWorkItem extends JsonObject {
  work_item_id: string;
  outcome_id: string;
  title: string;
  acceptance: string;
  authority_tier: CompanyAuthorityTier;
  ai_capable: boolean;
  prohibited: boolean;
  material_decision: boolean;
  human_identity_required: boolean;
  wait_for?: string;
  target_key: string;
}

interface RoutedCompanyWorkItem extends CompanyWorkItem {
  route: CompanyWorkRoute;
  route_reason: string;
  status:
    | "ready"
    | "waiting_human_decision"
    | "waiting_human_execution"
    | "waiting_external_evidence"
    | "cancelled";
  todo_projection: JsonObject;
}

function boundedArray(
  value: unknown,
  label: string,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new EffectRuntimeRequestError(`${label} must be an array`);
  }
  if (value.length > maximum) {
    throw new EffectRuntimeRequestError(
      `${label} must contain at most ${maximum} items`,
    );
  }
  return value;
}

function publicId(value: unknown, label: string): string {
  const normalized = requireNonEmptyString(value, label);
  if (!PUBLIC_ID.test(normalized)) {
    throw new EffectRuntimeRequestError(`${label} must be a public-safe id`);
  }
  return normalized;
}

function requireUniqueIds(
  values: readonly JsonObject[],
  field: string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const identifier = String(value[field]);
    if (seen.has(identifier)) {
      throw new EffectRuntimeRequestError(`${label} must be unique`);
    }
    seen.add(identifier);
  }
}

function companyWorkItem(value: unknown, label: string): CompanyWorkItem {
  const raw = requireJsonObject(value, label);
  const waitFor = optionalNonEmptyString(raw.wait_for, `${label}.wait_for`);
  return {
    work_item_id: publicId(raw.work_item_id, `${label}.work_item_id`),
    outcome_id: publicId(raw.outcome_id, `${label}.outcome_id`),
    title: requireNonEmptyString(raw.title, `${label}.title`),
    acceptance: requireNonEmptyString(raw.acceptance, `${label}.acceptance`),
    authority_tier: requireStringLiteral(
      raw.authority_tier,
      ["A", "B", "C", "D"] as const,
      `${label}.authority_tier`,
    ),
    ai_capable: requireBoolean(raw.ai_capable, `${label}.ai_capable`),
    prohibited: raw.prohibited === undefined
      ? false
      : requireBoolean(raw.prohibited, `${label}.prohibited`),
    material_decision: raw.material_decision === undefined
      ? false
      : requireBoolean(raw.material_decision, `${label}.material_decision`),
    human_identity_required: raw.human_identity_required === undefined
      ? false
      : requireBoolean(
        raw.human_identity_required,
        `${label}.human_identity_required`,
      ),
    ...(waitFor === null ? {} : { wait_for: waitFor }),
    target_key: publicId(raw.target_key, `${label}.target_key`),
  };
}

export function routeCompanyWorkItem(
  item: CompanyWorkItem,
): { route: CompanyWorkRoute; reason: string } {
  if (item.prohibited || item.authority_tier === "D") {
    return {
      route: "reject",
      reason: "policy or current authority prohibits execution",
    };
  }
  if (item.wait_for) {
    return {
      route: "observe",
      reason: "work depends on a future external state",
    };
  }
  if (item.material_decision || item.authority_tier === "B") {
    return {
      route: "human_decide",
      reason: "a material choice or authority grant is required",
    };
  }
  if (item.human_identity_required || item.authority_tier === "C") {
    return {
      route: "human_execute",
      reason: "a human identity or physical action is required",
    };
  }
  if (item.ai_capable && item.authority_tier === "A") {
    return {
      route: "ai_execute",
      reason: "AI capability, authority, and acceptance criteria are present",
    };
  }
  return {
    route: "human_decide",
    reason: "AI execution preconditions are incomplete",
  };
}

function routeStatus(route: CompanyWorkRoute): RoutedCompanyWorkItem["status"] {
  switch (route) {
    case "ai_execute": return "ready";
    case "human_decide": return "waiting_human_decision";
    case "human_execute": return "waiting_human_execution";
    case "observe": return "waiting_external_evidence";
    case "reject": return "cancelled";
  }
}

function todoProjection(item: CompanyWorkItem, route: CompanyWorkRoute): JsonObject {
  const mapping: Record<CompanyWorkRoute, readonly [string, string]> = {
    ai_execute: ["agent", "advancement_task"],
    human_decide: ["user", "user_gate"],
    human_execute: ["user", "user_action"],
    observe: ["agent", "continuous_monitor"],
    reject: ["agent", "blocker"],
  };
  const [role, taskClass] = mapping[route];
  return {
    role,
    task_class: taskClass,
    action_kind: route,
    target_key: item.target_key,
    text: item.title,
    acceptance: item.acceptance,
  };
}

function projectWorkItem(value: unknown, label: string): RoutedCompanyWorkItem {
  const item = companyWorkItem(value, label);
  const decision = routeCompanyWorkItem(item);
  return {
    ...item,
    route: decision.route,
    route_reason: decision.reason,
    status: routeStatus(decision.route),
    todo_projection: todoProjection(item, decision.route),
  };
}

function projectFeedback(value: unknown, label: string): JsonObject {
  const raw = requireJsonObject(value, label);
  const kind = requireStringLiteral(
    raw.kind,
    [
      "fact",
      "decision",
      "execution_result",
      "risk",
      "metric_change",
      "comment",
    ] as const,
    `${label}.kind`,
  );
  return {
    feedback_id: publicId(raw.feedback_id, `${label}.feedback_id`),
    source: requireNonEmptyString(raw.source, `${label}.source`),
    subject: requireNonEmptyString(raw.subject, `${label}.subject`),
    kind,
    observed_at: requireNonEmptyString(raw.observed_at, `${label}.observed_at`),
    evidence_ref: requireNonEmptyString(raw.evidence_ref, `${label}.evidence_ref`),
    affected_outcome_ids: requireStringArray(
      raw.affected_outcome_ids,
      `${label}.affected_outcome_ids`,
    ).map((item, index) => publicId(
      item,
      `${label}.affected_outcome_ids[${index}]`,
    )),
    disposition: kind === "comment" ? "recorded" : "replan",
  };
}

/**
 * Validate one company-level planning snapshot and project each open unit of
 * work into LoopX's existing Todo lanes. This is a pure control-plane
 * contract: providers own collection and execution, while LoopX owns routing
 * precedence and the provider-neutral projection.
 */
export function projectCompanyControlLoop(value: unknown): JsonObject {
  const request = requireJsonObject(value, "company_control_loop_request");
  if (request.schema_version !== COMPANY_CONTROL_LOOP_REQUEST_SCHEMA_VERSION) {
    throw new EffectRuntimeRequestError(
      `company_control_loop_request.schema_version must be ${COMPANY_CONTROL_LOOP_REQUEST_SCHEMA_VERSION}`,
    );
  }
  const cycle = requireInteger(request.cycle, "company_control_loop_request.cycle");
  if (cycle < 0 || !Number.isSafeInteger(cycle)) {
    throw new EffectRuntimeRequestError(
      "company_control_loop_request.cycle must be a non-negative safe integer",
    );
  }
  const outcomes = boundedArray(
    request.outcomes,
    "company_control_loop_request.outcomes",
    MAX_OUTCOMES,
  ).map((value, index) => {
    const raw = requireJsonObject(
      value,
      `company_control_loop_request.outcomes[${index}]`,
    );
    return {
      outcome_id: publicId(
        raw.outcome_id,
        `company_control_loop_request.outcomes[${index}].outcome_id`,
      ),
      title: requireNonEmptyString(
        raw.title,
        `company_control_loop_request.outcomes[${index}].title`,
      ),
      metric: requireNonEmptyString(
        raw.metric,
        `company_control_loop_request.outcomes[${index}].metric`,
      ),
      target: requireNonEmptyString(
        raw.target,
        `company_control_loop_request.outcomes[${index}].target`,
      ),
      evidence_source: requireNonEmptyString(
        raw.evidence_source,
        `company_control_loop_request.outcomes[${index}].evidence_source`,
      ),
    };
  });
  requireUniqueIds(outcomes, "outcome_id", "company outcome_id values");
  const outcomeIds = new Set(outcomes.map((outcome) => outcome.outcome_id));
  const workItems = boundedArray(
    request.work_items,
    "company_control_loop_request.work_items",
    MAX_WORK_ITEMS,
  ).map((item, index) => projectWorkItem(
    item,
    `company_control_loop_request.work_items[${index}]`,
  ));
  requireUniqueIds(workItems, "work_item_id", "company work_item_id values");
  requireUniqueIds(workItems, "target_key", "company work target_key values");
  for (const [index, item] of workItems.entries()) {
    if (!outcomeIds.has(item.outcome_id)) {
      throw new EffectRuntimeRequestError(
        `company_control_loop_request.work_items[${index}].outcome_id must reference an outcome`,
      );
    }
  }
  const feedback = boundedArray(
    request.feedback,
    "company_control_loop_request.feedback",
    MAX_FEEDBACK_ITEMS,
  ).map((item, index) => projectFeedback(
    item,
    `company_control_loop_request.feedback[${index}]`,
  ));
  requireUniqueIds(feedback, "feedback_id", "company feedback_id values");
  for (const [index, item] of feedback.entries()) {
    for (const outcomeId of item.affected_outcome_ids as string[]) {
      if (!outcomeIds.has(outcomeId)) {
        throw new EffectRuntimeRequestError(
          `company_control_loop_request.feedback[${index}].affected_outcome_ids must reference outcomes`,
        );
      }
    }
  }
  return {
    schema_version: COMPANY_CONTROL_LOOP_SCHEMA_VERSION,
    direction: requireNonEmptyString(
      request.direction,
      "company_control_loop_request.direction",
    ),
    cycle,
    outcomes,
    work_items: workItems,
    feedback,
    replan_required: feedback.some((item) => item.disposition === "replan"),
  };
}

/**
 * Convert the executable reference implementation's persisted v0 state into
 * the native request contract. The upgrade is preview-only and fails closed
 * when legacy feedback points at Goal ids that cannot be proven to be Outcome
 * ids.
 */
export function upgradeCompanyControlLoopState(value: unknown): JsonObject {
  const source = requireJsonObject(value, "company_control_loop_state");
  if (source.schema_version === COMPANY_CONTROL_LOOP_REQUEST_SCHEMA_VERSION) {
    projectCompanyControlLoop(source);
    return {
      schema_version: COMPANY_CONTROL_LOOP_UPGRADE_SCHEMA_VERSION,
      source_schema_version: COMPANY_CONTROL_LOOP_REQUEST_SCHEMA_VERSION,
      target_schema_version: COMPANY_CONTROL_LOOP_REQUEST_SCHEMA_VERSION,
      changed: false,
      state: structuredClone(source),
    };
  }
  if (source.schema_version !== LEGACY_COMPANY_CONTROL_STATE_SCHEMA_VERSION) {
    throw new EffectRuntimeRequestError(
      "company_control_loop_state.schema_version is unsupported",
    );
  }
  const outcomes = boundedArray(
    source.outcomes,
    "company_control_loop_state.outcomes",
    MAX_OUTCOMES,
  ).map((item, index) => {
    const raw = requireJsonObject(item, `company_control_loop_state.outcomes[${index}]`);
    return {
      outcome_id: raw.outcome_id,
      title: raw.title,
      metric: raw.metric,
      target: raw.target,
      evidence_source: raw.evidence_source,
    };
  });
  const outcomeIds = new Set(outcomes.map((item) => String(item.outcome_id)));
  const feedback = boundedArray(
    source.feedback ?? [],
    "company_control_loop_state.feedback",
    MAX_FEEDBACK_ITEMS,
  ).map((item, index) => {
    const raw = requireJsonObject(item, `company_control_loop_state.feedback[${index}]`);
    const affected = raw.affected_outcome_ids ?? raw.affected_goal_ids;
    const affectedIds = requireStringArray(
      affected,
      `company_control_loop_state.feedback[${index}].affected_outcome_ids`,
    );
    if (affectedIds.some((id) => !outcomeIds.has(id))) {
      throw new EffectRuntimeRequestError(
        `company_control_loop_state.feedback[${index}] needs an explicit Outcome mapping`,
      );
    }
    return {
      feedback_id: raw.feedback_id,
      source: raw.source,
      subject: raw.subject,
      kind: raw.kind,
      observed_at: raw.observed_at,
      evidence_ref: raw.evidence_ref,
      affected_outcome_ids: affectedIds,
    };
  });
  const request: JsonObject = {
    schema_version: COMPANY_CONTROL_LOOP_REQUEST_SCHEMA_VERSION,
    direction: source.company_direction,
    cycle: source.cycle ?? 0,
    outcomes,
    work_items: boundedArray(
      source.work_items,
      "company_control_loop_state.work_items",
      MAX_WORK_ITEMS,
    ).map((item, index) => {
      const raw = requireJsonObject(item, `company_control_loop_state.work_items[${index}]`);
      return {
        work_item_id: raw.work_item_id,
        outcome_id: raw.outcome_id,
        title: raw.title,
        acceptance: raw.acceptance,
        authority_tier: raw.authority_tier,
        ai_capable: raw.ai_capable,
        ...(raw.prohibited === undefined ? {} : { prohibited: raw.prohibited }),
        ...(raw.material_decision === undefined
          ? {}
          : { material_decision: raw.material_decision }),
        ...(raw.human_identity_required === undefined
          ? {}
          : { human_identity_required: raw.human_identity_required }),
        ...(raw.wait_for === undefined ? {} : { wait_for: raw.wait_for }),
        target_key: raw.target_key,
      };
    }),
    feedback,
  };
  projectCompanyControlLoop(request);
  return {
    schema_version: COMPANY_CONTROL_LOOP_UPGRADE_SCHEMA_VERSION,
    source_schema_version: LEGACY_COMPANY_CONTROL_STATE_SCHEMA_VERSION,
    target_schema_version: COMPANY_CONTROL_LOOP_REQUEST_SCHEMA_VERSION,
    changed: true,
    state: request,
  };
}
