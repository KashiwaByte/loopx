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


def _stored_projection(*work_items: dict[str, object]) -> dict[str, object]:
    return {
        "schema_version": "company_control_state_store_result_v0",
        "operation": "load",
        "goal_id": "company-goal",
        "state": {
            "revision": "a" * 64,
            "projection": {
                "schema_version": "company_control_loop_v0",
                "work_items": list(work_items),
            },
        },
    }


def _routed_work(
    work_item_id: str,
    target_key: str,
    *,
    role: str = "agent",
    task_class: str = "advancement_task",
    action_kind: str = "ai_execute",
) -> dict[str, object]:
    return {
        "work_item_id": work_item_id,
        "target_key": target_key,
        "todo_projection": {
            "role": role,
            "task_class": task_class,
            "action_kind": action_kind,
            "target_key": target_key,
            "text": f"Advance {work_item_id}",
            "acceptance": f"Evidence for {work_item_id}",
        },
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


def test_company_control_loop_save_previews_then_writes_with_revision(
    tmp_path, monkeypatch, capsys
) -> None:
    state_path = tmp_path / "company.json"
    state_path.write_text(json.dumps(_request()), encoding="utf-8")
    calls: list[str] = []

    def runtime(method: str, params: dict[str, object]) -> dict[str, object]:
        calls.append(method)
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
    assert calls == ["work_item.company_control_loop.project"]

    calls.clear()
    assert main([*common, "--expected-revision", "a" * 64, "--execute"]) == 0
    assert json.loads(capsys.readouterr().out)["written"] is True
    assert calls == [
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


def test_company_control_loop_sync_todos_previews_existing_and_missing(
    tmp_path, monkeypatch, capsys
) -> None:
    monkeypatch.setattr(
        company_control_loop,
        "effect_runtime_result",
        lambda method, params: _stored_projection(
            _routed_work("work_existing", "target_existing"),
            _routed_work("work_missing", "target_missing"),
        ),
    )
    monkeypatch.setattr(
        company_control_loop,
        "list_goal_todos",
        lambda **kwargs: {
            "todos": [{
                "todo_id": "todo_existing",
                "target_key": "target_existing",
                "status": "open",
            }]
        },
    )
    writes: list[dict[str, object]] = []
    monkeypatch.setattr(
        company_control_loop,
        "add_goal_todo",
        lambda **kwargs: writes.append(kwargs),
    )

    assert main([
        "--format", "json", "--registry", str(tmp_path / "registry.json"),
        "--runtime-root", str(tmp_path / "runtime"),
        "company-control-loop", "sync-todos", "--goal-id", "company-goal",
        "--agent-id", "agent-ceo", "--project", str(tmp_path),
    ]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["dry_run"] is True
    assert payload["readback_verified"] is False
    assert [item["action"] for item in payload["actions"]] == [
        "linked_existing", "would_create",
    ]
    assert writes == []


def test_company_control_loop_sync_todos_creates_and_verifies_readback(
    tmp_path, monkeypatch, capsys
) -> None:
    monkeypatch.setattr(
        company_control_loop,
        "effect_runtime_result",
        lambda method, params: _stored_projection(
            _routed_work(
                "work_decision",
                "target_decision",
                role="user",
                task_class="user_gate",
                action_kind="human_decide",
            ),
            _routed_work(
                "work_watch",
                "target_watch",
                task_class="continuous_monitor",
                action_kind="observe",
            ),
        ),
    )
    listings = iter([
        {"todos": []},
        {"todos": [
            {"todo_id": "todo_decision", "target_key": "target_decision"},
            {"todo_id": "todo_watch", "target_key": "target_watch"},
        ]},
    ])
    monkeypatch.setattr(
        company_control_loop, "list_goal_todos", lambda **kwargs: next(listings)
    )
    writes: list[dict[str, object]] = []

    def add(**kwargs: object) -> dict[str, object]:
        writes.append(kwargs)
        return {"todo_id": f"created_{len(writes)}"}

    monkeypatch.setattr(company_control_loop, "add_goal_todo", add)

    assert main([
        "--format", "json", "--registry", str(tmp_path / "registry.json"),
        "--runtime-root", str(tmp_path / "runtime"),
        "company-control-loop", "sync-todos", "--goal-id", "company-goal",
        "--agent-id", "agent-ceo", "--project", str(tmp_path), "--execute",
    ]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["readback_verified"] is True
    assert [item["todo_id"] for item in payload["actions"]] == [
        "todo_decision", "todo_watch",
    ]
    assert writes[0]["blocks_agent"] == "agent-ceo"
    assert writes[0]["decision_scope"] == "direction:action:target_decision"
    assert writes[1]["monitor_metadata"] == {
        "target_key": "target_watch",
        "watch_only": "true",
    }


def test_company_control_loop_sync_todos_fails_on_missing_readback(
    tmp_path, monkeypatch, capsys
) -> None:
    monkeypatch.setattr(
        company_control_loop,
        "effect_runtime_result",
        lambda method, params: _stored_projection(
            _routed_work("work_missing", "target_missing")
        ),
    )
    listings = iter([{"todos": []}, {"todos": []}])
    monkeypatch.setattr(
        company_control_loop, "list_goal_todos", lambda **kwargs: next(listings)
    )
    monkeypatch.setattr(
        company_control_loop,
        "add_goal_todo",
        lambda **kwargs: {"todo_id": "todo_unreadable"},
    )

    assert main([
        "--format", "json", "--registry", str(tmp_path / "registry.json"),
        "--runtime-root", str(tmp_path / "runtime"),
        "company-control-loop", "sync-todos", "--goal-id", "company-goal",
        "--agent-id", "agent-ceo", "--project", str(tmp_path), "--execute",
    ]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert "readback missing target keys" in payload["error"]


def test_company_control_loop_reconcile_todos_sends_evidence_to_typed_owner(
    tmp_path, monkeypatch, capsys
) -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    def runtime(method: str, params: dict[str, object]) -> dict[str, object]:
        calls.append((method, params))
        if method.endswith(".load"):
            return _stored_projection(
                _routed_work("work_activation", "target_activation")
            )
        return {
            "schema_version": "company_control_state_store_result_v0",
            "operation": "reconcile",
            "dry_run": True,
            "written": False,
        }

    monkeypatch.setattr(company_control_loop, "effect_runtime_result", runtime)
    monkeypatch.setattr(
        company_control_loop,
        "list_goal_todos",
        lambda **kwargs: {"todos": [
            {
                "todo_id": "todo_activation",
                "target_key": "target_activation",
                "status": "done",
                "evidence": "artifact:activation-report",
            },
            {
                "todo_id": "todo_unrelated",
                "target_key": "other_target",
                "status": "done",
            },
        ]},
    )

    assert main([
        "--format", "json", "--registry", str(tmp_path / "registry.json"),
        "--runtime-root", str(tmp_path / "runtime"),
        "company-control-loop", "reconcile-todos", "--goal-id", "company-goal",
        "--agent-id", "agent-ceo", "--project", str(tmp_path),
    ]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["dry_run"] is True
    assert calls[1][0] == "work_item.company_control_state.reconcile"
    assert calls[1][1]["expected_revision"] == "a" * 64
    assert calls[1][1]["execute"] is False
    assert calls[1][1]["observations"] == [{
        "target_key": "target_activation",
        "todo_id": "todo_activation",
        "status": "done",
        "evidence_ref": "artifact:activation-report",
    }]


def test_company_control_loop_reconcile_todos_rejects_duplicate_targets(
    tmp_path, monkeypatch, capsys
) -> None:
    monkeypatch.setattr(
        company_control_loop,
        "effect_runtime_result",
        lambda method, params: _stored_projection(
            _routed_work("work_activation", "target_activation")
        ),
    )
    monkeypatch.setattr(
        company_control_loop,
        "list_goal_todos",
        lambda **kwargs: {"todos": [
            {"todo_id": "todo_first", "target_key": "target_activation", "status": "open"},
            {"todo_id": "todo_second", "target_key": "target_activation", "status": "done"},
        ]},
    )
    assert main([
        "--format", "json", "--registry", str(tmp_path / "registry.json"),
        "--runtime-root", str(tmp_path / "runtime"),
        "company-control-loop", "reconcile-todos", "--goal-id", "company-goal",
        "--agent-id", "agent-ceo", "--execute",
    ]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert "multiple LoopX Todos" in payload["error"]


def test_company_control_loop_next_cycle_uses_persisted_reconciliation(
    tmp_path, monkeypatch, capsys
) -> None:
    stored = _stored_projection(
        _routed_work("work_activation", "target_activation")
    )
    state = stored["state"]
    assert isinstance(state, dict)
    state["reconciliation"] = {
        "schema_version": "company_control_state_reconciliation_v0",
        "observations": [{
            "work_item_id": "work_activation",
            "target_key": "target_activation",
            "todo_id": "todo_activation",
            "todo_status": "done",
            "prior_status": "ready",
            "next_status": "done",
            "evidence_ref": "artifact:activation-report",
            "changed": True,
        }],
        "replan_required": False,
    }
    calls: list[tuple[str, dict[str, object]]] = []

    def runtime(method: str, params: dict[str, object]) -> dict[str, object]:
        calls.append((method, params))
        if method.endswith(".load"):
            return stored
        return {
            "schema_version": "company_control_next_cycle_v0",
            "goal_id": "company-goal",
            "goal_converged": True,
            "remaining_work_item_count": 0,
        }

    monkeypatch.setattr(company_control_loop, "effect_runtime_result", runtime)
    assert main([
        "--format", "json", "--runtime-root", str(tmp_path / "runtime"),
        "company-control-loop", "next-cycle", "--goal-id", "company-goal",
    ]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["goal_converged"] is True
    assert calls[1][0] == "work_item.company_control_state.next_cycle"
    assert calls[1][1]["state"] == state
