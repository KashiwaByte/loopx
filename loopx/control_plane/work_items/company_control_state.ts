import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { JsonObject } from "../effect_program.ts";
import {
  EffectRuntimeConflictError,
  EffectRuntimeRequestError,
} from "../effect_runtime_errors.ts";
import { atomicWriteJson, withFileMutationLock } from "../effect_runtime_io.ts";
import {
  optionalNonEmptyString,
  requireJsonObject,
  requireNonEmptyString,
} from "../runtime_decode.ts";
import {
  COMPANY_CONTROL_LOOP_SCHEMA_VERSION,
  projectCompanyControlLoop,
} from "./company_control_loop.ts";

export const COMPANY_CONTROL_STATE_STORE_REQUEST_SCHEMA =
  "company_control_state_store_request_v0";
export const COMPANY_CONTROL_STATE_STORE_SCHEMA =
  "company_control_state_store_v0";
export const COMPANY_CONTROL_STATE_STORE_RESULT_SCHEMA =
  "company_control_state_store_result_v0";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function revision(projection: JsonObject): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(projection)), "utf8")
    .digest("hex");
}

function safeGoalSegment(goalId: string): string {
  const label = goalId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 47) || "goal";
  const digest = createHash("sha256").update(goalId, "utf8").digest("hex").slice(0, 16);
  return `${label}-${digest}`;
}

export function companyControlStatePath(runtimeRoot: string, goalId: string): string {
  if (!isAbsolute(runtimeRoot)) {
    throw new EffectRuntimeRequestError("runtime_root must be absolute");
  }
  return join(
    runtimeRoot,
    "goals",
    safeGoalSegment(goalId),
    "company-control-loop",
    "state.json",
  );
}

function storeRequest(value: unknown): {
  request: JsonObject;
  goalId: string;
  path: string;
} {
  const request = requireJsonObject(value, "company_control_state_store params");
  if (request.schema_version !== COMPANY_CONTROL_STATE_STORE_REQUEST_SCHEMA) {
    throw new EffectRuntimeRequestError("company control state store request schema mismatch");
  }
  const runtimeRoot = requireNonEmptyString(request.runtime_root, "runtime_root");
  const goalId = requireNonEmptyString(request.goal_id, "goal_id");
  return { request, goalId, path: companyControlStatePath(runtimeRoot, goalId) };
}

function decodeStoredState(value: unknown, goalId: string): JsonObject {
  const stored = requireJsonObject(value, "stored company control state");
  if (
    stored.schema_version !== COMPANY_CONTROL_STATE_STORE_SCHEMA ||
    stored.goal_id !== goalId ||
    typeof stored.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(stored.revision)
  ) {
    throw new EffectRuntimeRequestError("stored company control state is invalid");
  }
  const projection = requireJsonObject(stored.projection, "stored projection");
  if (projection.schema_version !== COMPANY_CONTROL_LOOP_SCHEMA_VERSION) {
    throw new EffectRuntimeRequestError("stored company control projection schema is invalid");
  }
  if (revision(projection) !== stored.revision) {
    throw new EffectRuntimeRequestError("stored company control state revision does not match content");
  }
  return stored;
}

async function readStoredState(path: string, goalId: string): Promise<JsonObject | null> {
  try {
    return decodeStoredState(JSON.parse(await readFile(path, "utf8")), goalId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function loadCompanyControlState(value: unknown): Promise<JsonObject> {
  const { goalId, path } = storeRequest(value);
  return {
    schema_version: COMPANY_CONTROL_STATE_STORE_RESULT_SCHEMA,
    operation: "load",
    goal_id: goalId,
    path,
    state: await readStoredState(path, goalId),
  };
}

export async function writeCompanyControlState(value: unknown): Promise<JsonObject> {
  const { request, goalId, path } = storeRequest(value);
  const expectedRevision = optionalNonEmptyString(
    request.expected_revision,
    "expected_revision",
  );
  const projection = projectCompanyControlLoop(request.state);
  const nextRevision = revision(projection);
  return await withFileMutationLock(path, async () => {
    const existing = await readStoredState(path, goalId);
    if (existing?.revision === nextRevision) {
      return {
        schema_version: COMPANY_CONTROL_STATE_STORE_RESULT_SCHEMA,
        operation: "write",
        goal_id: goalId,
        path,
        state: existing,
        written: false,
        replayed: true,
      };
    }
    if (existing && expectedRevision === null) {
      throw new EffectRuntimeConflictError(
        "expected_revision is required when company control state already exists",
      );
    }
    if (expectedRevision !== (existing?.revision ?? null)) {
      throw new EffectRuntimeConflictError("company control state revision changed");
    }
    const stored: JsonObject = {
      schema_version: COMPANY_CONTROL_STATE_STORE_SCHEMA,
      goal_id: goalId,
      revision: nextRevision,
      updated_at: requireNonEmptyString(request.updated_at, "updated_at"),
      projection,
    };
    await atomicWriteJson(path, stored);
    const readback = await readStoredState(path, goalId);
    if (!readback || readback.revision !== nextRevision) {
      throw new Error("company control state readback failed");
    }
    return {
      schema_version: COMPANY_CONTROL_STATE_STORE_RESULT_SCHEMA,
      operation: "write",
      goal_id: goalId,
      path,
      state: readback,
      written: true,
      replayed: false,
    };
  });
}
