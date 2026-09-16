from __future__ import annotations

import json

from loopx.cli import main
from loopx.cli_commands import company_control_loop


def _request() -> dict[str, object]:
    return {
        "schema_version": "company_control_loop_request_v0",
        "direction": "Improve durable customer value.",
        "cycle": 1,
        "outcomes": [
            {
                "outcome_id": "outcome_activation",
                "title": "Improve activation",
                "metric": "seven day activation rate",
                "target": ">= 40%",
                "evidence_source": "activation analytics",
            }
        ],
        "work_items": [],
        "feedback": [],
    }


def test_company_control_loop_cli_calls_typed_projection(
    tmp_path, monkeypatch, capsys
) -> None:
    state_path = tmp_path / "company.json"
    state_path.write_text(json.dumps(_request()), encoding="utf-8")
    calls: list[tuple[str, dict[str, object]]] = []

    def project(method: str, params: dict[str, object]) -> dict[str, object]:
        calls.append((method, params))
        return {
            "schema_version": "company_control_loop_v0",
            "direction": params["direction"],
            "cycle": params["cycle"],
            "outcomes": params["outcomes"],
            "work_items": [],
            "feedback": [],
            "replan_required": False,
        }

    monkeypatch.setattr(company_control_loop, "effect_runtime_result", project)

    assert main([
        "--format",
        "json",
        "company-control-loop",
        "project",
        "--state-json",
        str(state_path),
    ]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["schema_version"] == "company_control_loop_v0"
    assert calls == [("work_item.company_control_loop.project", _request())]


def test_company_control_loop_cli_rejects_non_object_json(tmp_path, capsys) -> None:
    state_path = tmp_path / "company.json"
    state_path.write_text("[]", encoding="utf-8")

    assert main([
        "--format",
        "json",
        "company-control-loop",
        "project",
        "--state-json",
        str(state_path),
    ]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert "must contain an object" in payload["error"]
