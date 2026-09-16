from __future__ import annotations

import argparse
import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..control_plane.effect_runtime import effect_runtime_result


def register_company_control_loop_command(
    subparsers: argparse._SubParsersAction,
    add_subcommand_format: Callable[[argparse.ArgumentParser], None],
) -> None:
    parser = subparsers.add_parser(
        "company-control-loop",
        help="Validate and project a company planning snapshot into LoopX Todo lanes.",
    )
    add_subcommand_format(parser)
    actions = parser.add_subparsers(
        dest="company_control_loop_command",
        required=True,
    )
    project = actions.add_parser(
        "project",
        help="Project a company_control_loop_request_v0 JSON object without writing state.",
    )
    add_subcommand_format(project)
    project.add_argument(
        "--state-json",
        required=True,
        help="Path to a company_control_loop_request_v0 JSON object.",
    )
    upgrade = actions.add_parser(
        "upgrade",
        help="Preview conversion of a legacy loopx_company_control_state_v0 file.",
    )
    add_subcommand_format(upgrade)
    upgrade.add_argument(
        "--state-json",
        required=True,
        help="Path to a legacy or current company control state JSON object.",
    )
    save = actions.add_parser(
        "save",
        help="Validate and persist company control state under one Goal runtime.",
    )
    add_subcommand_format(save)
    save.add_argument("--goal-id", required=True, help="Goal that owns the company state.")
    save.add_argument("--state-json", required=True, help="Legacy or current company state JSON.")
    save.add_argument(
        "--expected-revision",
        help="Exact revision returned by show/save. Required to replace existing state.",
    )
    save.add_argument(
        "--execute",
        action="store_true",
        help="Persist the validated projection. Without this flag, return a preview.",
    )
    show = actions.add_parser(
        "show",
        help="Read the persisted company control state for one Goal.",
    )
    add_subcommand_format(show)
    show.add_argument("--goal-id", required=True, help="Goal that owns the company state.")


def render_company_control_loop_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# LoopX Company Control Loop",
        "",
        f"- ok: `{payload.get('ok')}`",
    ]
    if payload.get("error"):
        lines.append(f"- error: {payload['error']}")
        return "\n".join(lines)
    lines.extend([
        f"- schema_version: `{payload.get('schema_version')}`",
        f"- direction: {payload.get('direction')}",
        f"- cycle: {payload.get('cycle')}",
        f"- replan_required: `{payload.get('replan_required')}`",
        "",
        "## Work routing",
        "",
    ])
    work_items = payload.get("work_items")
    if not isinstance(work_items, list) or not work_items:
        lines.append("- No work items.")
    else:
        for item in work_items:
            if isinstance(item, dict):
                lines.append(
                    f"- `{item.get('work_item_id')}` -> `{item.get('route')}` "
                    f"({item.get('status')}): {item.get('title')}"
                )
    return "\n".join(lines)


def _read_json_object(path_text: str) -> dict[str, Any]:
    payload = json.loads(Path(path_text).expanduser().read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise TypeError("company control state JSON must contain an object")
    return payload


def handle_company_control_loop_command(
    args: argparse.Namespace,
    *,
    output_format: Callable[..., str],
    print_payload: Callable[[dict[str, Any], str, Callable[[dict[str, Any]], str]], None],
    runtime_root: Path | None = None,
) -> int | None:
    if args.command != "company-control-loop":
        return None
    try:
        command = args.company_control_loop_command
        if command == "show":
            if runtime_root is None:
                raise ValueError("company control state requires a runtime root")
            projection = effect_runtime_result(
                "work_item.company_control_state.load",
                {
                    "schema_version": "company_control_state_store_request_v0",
                    "runtime_root": str(runtime_root),
                    "goal_id": args.goal_id,
                },
            )
            payload = {"ok": True, **projection}
        else:
            request = _read_json_object(args.state_json)
            method = (
                "work_item.company_control_loop.upgrade"
                if command in {"upgrade", "save"}
                else "work_item.company_control_loop.project"
            )
            projection = effect_runtime_result(method, request)
            if command != "save":
                payload = {"ok": True, **projection}
            else:
                state = projection.get("state")
                if not isinstance(state, dict):
                    raise TypeError("company control upgrade did not return state")
                preview = effect_runtime_result(
                    "work_item.company_control_loop.project",
                    state,
                )
                if not args.execute:
                    payload = {
                        "ok": True,
                        "dry_run": True,
                        "goal_id": args.goal_id,
                        "projection": preview,
                    }
                else:
                    if runtime_root is None:
                        raise ValueError("company control state requires a runtime root")
                    write_request: dict[str, Any] = {
                        "schema_version": "company_control_state_store_request_v0",
                        "runtime_root": str(runtime_root),
                        "goal_id": args.goal_id,
                        "state": state,
                        "updated_at": datetime.now(UTC).isoformat(),
                    }
                    if args.expected_revision:
                        write_request["expected_revision"] = args.expected_revision
                    saved = effect_runtime_result(
                        "work_item.company_control_state.write",
                        write_request,
                    )
                    payload = {"ok": True, "dry_run": False, **saved}
        exit_code = 0
    except Exception as exc:
        payload = {"ok": False, "error": str(exc)}
        exit_code = 1
    print_payload(
        payload,
        output_format(args),
        render_company_control_loop_markdown,
    )
    return exit_code
