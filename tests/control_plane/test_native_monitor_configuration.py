"""Monitor configuration uses the public writer and actual local providers."""
from __future__ import annotations

import pytest
from canonical_authority_fixture import isolate_sqlite_runtime
from test_native_monitor_poll import _canonical
from test_monitor_followthrough_contract import _write_fixture, _add_monitor, GOAL_ID, AGENT_ID
from loopx.control_plane.testing.canary_harness import run_json_cli
from loopx.control_plane.coordination.local_authority import read_canonical_todos_if_promoted
from loopx.todos import list_goal_todos, update_goal_todo


def setup(tmp_path, provider):
    if provider == "legacy":
        registry, runtime, state = _write_fixture(tmp_path)
        monitor = _add_monitor(registry, text="Observe public changes", target_key="public-watch", next_due_at="2000-01-01T00:00:00Z")
        return registry, runtime, state, monitor
    return _canonical(tmp_path, provider=provider)


@pytest.mark.parametrize("provider", ["legacy", "file", "sqlite"])
def test_configuration_cli_and_clear_preserve_observation(tmp_path, monkeypatch, provider):
    isolate_sqlite_runtime(tmp_path, monkeypatch)
    registry, runtime, state, monitor = setup(tmp_path, provider)
    before = list_goal_todos(registry_path=registry, goal_id=GOAL_ID)["todos"][0]
    if provider != "legacy":
        state.unlink()
    args = ("todo", "update", "--goal-id", GOAL_ID, "--todo-id", monitor["todo_id"],
            "--agent-id", AGENT_ID, "--cadence", "2h", "--next-due-at", "2099-01-01T02:00:00Z")
    identity = () if provider == "legacy" else ("--update-operation-id", "configuration-a")
    run_json_cli(*args, *identity, "--dry-run", registry_path=registry, runtime_root=runtime)
    if provider != "legacy":
        assert not state.exists()
    result = run_json_cli(*args, *identity, registry_path=registry, runtime_root=runtime)
    current = list_goal_todos(registry_path=registry, goal_id=GOAL_ID)["todos"][0]
    assert current["cadence"] == "2h"
    for field in ("result_hash", "material_change_generation", "last_checked_at", "monitor_effect_id", "consecutive_no_change"):
        assert current.get(field) == before.get(field)
    if provider != "legacy":
        assert result["source_authority"] == ("file_v0" if provider == "file" else "sqlite_v0")
        replay = run_json_cli(*args, *identity, registry_path=registry, runtime_root=runtime)
        assert replay["status"] == "replayed"
    update_goal_todo(registry_path=registry, runtime_root_arg=str(runtime), goal_id=GOAL_ID,
        todo_id=monitor["todo_id"], agent_id=AGENT_ID,
        monitor_metadata={"watch_only": None, "expires_at": "2099-02-01T00:00:00Z"})
    current = list_goal_todos(registry_path=registry, goal_id=GOAL_ID)["todos"][0]
    assert not current.get("watch_only")
    assert current["expires_at"] == "2099-02-01T00:00:00Z"


@pytest.mark.parametrize("provider", ["file", "sqlite"])
def test_configuration_rejection_and_delivery_recovery(tmp_path, monkeypatch, provider):
    isolate_sqlite_runtime(tmp_path, monkeypatch)
    registry, runtime, state, monitor = setup(tmp_path, provider)
    args = dict(registry_path=registry, runtime_root_arg=str(runtime), goal_id=GOAL_ID,
                todo_id=monitor["todo_id"], agent_id=AGENT_ID)
    before = read_canonical_todos_if_promoted(runtime_root=runtime, goal_id=GOAL_ID)
    for metadata in ({"material_change_generation": 100}, {"cadence": "never"}, {"watch_only": None}, {"unknown": "x"}):
        with pytest.raises((ValueError, RuntimeError)):
            update_goal_todo(**args, text="Must not partially commit", monitor_metadata=metadata)
        assert read_canonical_todos_if_promoted(runtime_root=runtime, goal_id=GOAL_ID) == before
    import loopx.control_plane.todos.provider_projection as delivery
    def unavailable(**kwargs):
        raise OSError("synthetic delivery outage")
    with monkeypatch.context() as m:
        m.setattr(delivery, "project_current_canonical_todos", unavailable)
        result = update_goal_todo(**args, monitor_metadata={"cadence": "3h"}, update_operation_id="recover-config")
        assert result["projection_delivery"] == "pending"
    replay = update_goal_todo(**args, monitor_metadata={"cadence": "3h"}, update_operation_id="recover-config")
    assert replay["status"] == "replayed"
    assert replay["projection_delivery"] == "delivered"


@pytest.mark.parametrize("provider", ["legacy", "file", "sqlite"])
def test_observed_target_cannot_be_repurposed_by_configuration(tmp_path, monkeypatch, provider):
    from loopx.control_plane.scheduler.monitor_poll_writeback import write_monitor_poll_todo_state
    isolate_sqlite_runtime(tmp_path, monkeypatch)
    registry, runtime, _state, monitor = setup(tmp_path, provider)
    write_monitor_poll_todo_state(registry_path=registry, runtime_root=runtime, goal_id=GOAL_ID,
        execute=True, todo_id=monitor["todo_id"], agent_id=AGENT_ID, monitor_effect_id="observed-target",
        generated_at="2030-01-01T00:00:00Z", result_hash="original-target-result", material_change=True)
    before = list_goal_todos(registry_path=registry, goal_id=GOAL_ID)["todos"]
    for metadata in ({"target_key": "another-target"}, {"target_key": None}, {"result_hash": "invented"}):
        with pytest.raises((ValueError, RuntimeError)):
            update_goal_todo(registry_path=registry, runtime_root_arg=str(runtime), goal_id=GOAL_ID,
                todo_id=monitor["todo_id"], agent_id=AGENT_ID, monitor_metadata=metadata)
        assert list_goal_todos(registry_path=registry, goal_id=GOAL_ID)["todos"] == before
