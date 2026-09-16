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


def test_company_control_loop_cli_selects_upgrade_contract(
    tmp_path, monkeypatch, capsys
) -> None:
    state_path = tmp_path / "company.json"
    state_path.write_text(json.dumps(_request()), encoding="utf-8")
    calls: list[str] = []

    def upgrade(method: str, params: dict[str, object]) -> dict[str, object]:
        calls.append(method)
        return {
            "schema_version": "company_control_loop_upgrade_v0",
            "source_schema_version": params["schema_version"],
            "target_schema_version": params["schema_version"],
            "changed": False,
            "state": params,
        }

    monkeypatch.setattr(company_control_loop, "effect_runtime_result", upgrade)
    assert main([
        "--format",
        "json",
        "company-control-loop",
        "upgrade",
        "--state-json",
        str(state_path),
    ]) == 0
    json.loads(capsys.readouterr().out)
    assert calls == ["work_item.company_control_loop.upgrade"]


def test_company_control_loop_save_previews_then_writes_with_revision(
    tmp_path, monkeypatch, capsys
) -> None:
    state_path = tmp_path / "company.json"
    state_path.write_text(json.dumps(_request()), encoding="utf-8")
    calls: list[str] = []

    def runtime(method: str, params: dict[str, object]) -> dict[str, object]:
        calls.append(method)
        if method.endswith("upgrade"):
            return {"state": params}
        if method.endswith("project"):
            return {"schema_version": "company_control_loop_v0"}
        assert params["expected_revision"] == "a" * 64
        return {
            "schema_version": "company_control_state_store_result_v0",
            "operation": "write",
            "written": True,
            "replayed": False,
            "state": {"revision": "b" * 64},
        }

    monkeypatch.setattr(company_control_loop, "effect_runtime_result", runtime)
    common = [
        "--format", "json", "--runtime-root", str(tmp_path / "runtime"),
        "company-control-loop", "save", "--goal-id", "company-goal",
        "--state-json", str(state_path),
    ]
    assert main(common) == 0
    assert json.loads(capsys.readouterr().out)["dry_run"] is True
    assert calls == [
        "work_item.company_control_loop.upgrade",
        "work_item.company_control_loop.project",
    ]

    calls.clear()
    assert main([*common, "--expected-revision", "a" * 64, "--execute"]) == 0
    assert json.loads(capsys.readouterr().out)["written"] is True
    assert calls == [
        "work_item.company_control_loop.upgrade",
        "work_item.company_control_loop.project",
        "work_item.company_control_state.write",
    ]


def test_company_control_loop_show_reads_goal_state(tmp_path, monkeypatch, capsys) -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    def runtime(method: str, params: dict[str, object]) -> dict[str, object]:
        calls.append((method, params))
        return {
            "schema_version": "company_control_state_store_result_v0",
            "operation": "load",
            "goal_id": params["goal_id"],
            "state": None,
        }

    monkeypatch.setattr(company_control_loop, "effect_runtime_result", runtime)
    assert main([
        "--format", "json", "--runtime-root", str(tmp_path / "runtime"),
        "company-control-loop", "show", "--goal-id", "company-goal",
    ]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["operation"] == "load"
    assert calls[0][0] == "work_item.company_control_state.load"
    assert calls[0][1]["goal_id"] == "company-goal"
