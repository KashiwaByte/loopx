from __future__ import annotations

import argparse
import json
from collections.abc import Callable
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
) -> int | None:
    if args.command != "company-control-loop":
        return None
    try:
        request = _read_json_object(args.state_json)
        projection = effect_runtime_result(
            "work_item.company_control_loop.project",
            request,
        )
        payload = {"ok": True, **projection}
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
