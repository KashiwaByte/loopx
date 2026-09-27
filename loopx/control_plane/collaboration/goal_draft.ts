/** Conversation drafts are editable suggestions, never creation or execution receipts. */
export type GoalDraft = {
  objective: string;
  completion_criteria: string;
  execution_boundary: string;
  question: string;
  options: string[];
};

export function normalizeGoalDraft(value: unknown): GoalDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const fields = ["objective", "completion_criteria", "execution_boundary", "question"] as const;
  if (Object.keys(row).some(key => ![...fields, "options"].includes(key))) return null;
  if (fields.some(key => typeof row[key] !== "string" || Array.from(row[key] as string).length > 1000)) return null;
  if (!Array.isArray(row.options) || row.options.length > 5
    || row.options.some(option => typeof option !== "string" || !option.trim() || Array.from(option).length > 300)) return null;
  if (!(row.objective as string).trim()) return null;
  return {
    objective: (row.objective as string).trim(),
    completion_criteria: (row.completion_criteria as string).trim(),
    execution_boundary: (row.execution_boundary as string).trim(),
    question: (row.question as string).trim(),
    options: (row.question as string).trim() ? [...new Set(row.options.map(option => option.trim()))] : [],
  };
}
