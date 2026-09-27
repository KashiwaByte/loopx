import type { GoalDraft } from "../../../../../../loopx/control_plane/collaboration/goal_draft.js";
import { useWorkspaceI18n } from "./i18n";
import "./goal-draft-card.css";

export function GoalDraftCard({ draft, onReview, onSuggest }: {
  draft: GoalDraft;
  onReview?: (draft: GoalDraft) => void;
  onSuggest?: (text: string) => void;
}) {
  const { locale } = useWorkspaceI18n();
  const zh = locale === "zh-CN";
  return <section className="personal-goal-draft" aria-label={zh ? "目标草稿" : "Goal draft"}>
    <strong>{zh ? "目标草稿" : "Goal draft"}</strong>
    <dl>{[
      [zh ? "目标" : "Objective", draft.objective],
      [zh ? "完成标准" : "Completion criteria", draft.completion_criteria],
      [zh ? "执行边界" : "Execution boundary", draft.execution_boundary],
    ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || (zh ? "待补充" : "Not specified")}</dd></div>)}</dl>
    {draft.question ? <p>{draft.question}</p> : null}
    {onSuggest && draft.options.length ? <div className="personal-goal-draft-options">
      {draft.options.map(option => <button type="button" key={option} onClick={() => onSuggest(option)}>{option}</button>)}
      <small>{zh ? "点选后可修改再发送，也可以直接输入。" : "Choose a reply to edit before sending, or type your own."}</small>
    </div> : null}
    <footer><span>{zh ? "尚未创建或启动" : "Not created or started"}</span>
      {onReview ? <button type="button" onClick={() => onReview(draft)}>{zh ? "编辑并检查" : "Edit and review"}</button> : null}
    </footer>
  </section>;
}
