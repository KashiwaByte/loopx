# Company Control Loop

The Company Control Loop is LoopX's provider-neutral planning layer for a
long-running company direction. It routes bounded work to AI or people, keeps
the result under one Goal, reconciles Todo evidence, and produces the next
planning cycle.

## Authority boundary

The command does not grant execution authority. Existing LoopX Todo rules own
claims, user gates, leases, validation, and completion. The company layer owns
only these decisions:

- `ai_execute` becomes an agent advancement Todo.
- `human_decide` becomes a blocking user gate.
- `human_execute` becomes a user action.
- `observe` becomes a bounded continuous monitor.
- prohibited work becomes a blocker.

A Todo marked done is accepted only when reconciliation also receives an
evidence reference. Completion without evidence becomes `awaiting_evidence`;
a blocked Todo becomes `replanning`.

## State lifecycle

Start with a `company_control_loop_request_v0` JSON object. It contains one
direction, a cycle number, outcomes, work items, and feedback.

```sh
loopx company-control-loop project --state-json company.json
loopx company-control-loop save \
  --goal-id company-goal \
  --state-json company.json
```

Both commands are read-only at this point. Add `--execute` to `save` after
review. Replacing existing state also requires the exact revision returned by
`show` or the prior write:

```sh
loopx company-control-loop save \
  --goal-id company-goal \
  --state-json company.json \
  --expected-revision REVISION \
  --execute

loopx company-control-loop show --goal-id company-goal
```

Legacy `loopx_company_control_state_v0` files can be previewed with `upgrade`.
Ambiguous legacy Goal-to-Outcome feedback mappings fail closed.

## Materialize work as Todos

Preview the idempotent plan first, then execute it:

```sh
loopx company-control-loop sync-todos \
  --goal-id company-goal \
  --agent-id company-ceo \
  --project /path/to/project

loopx company-control-loop sync-todos \
  --goal-id company-goal \
  --agent-id company-ceo \
  --project /path/to/project \
  --execute
```

`target_key` links each work item to exactly one Todo. Existing links are
reused. Duplicate links and failed write readback stop the command.

## Reconcile and plan the next cycle

Reconciliation is also dry-run by default:

```sh
loopx company-control-loop reconcile-todos \
  --goal-id company-goal \
  --agent-id company-ceo \
  --project /path/to/project

loopx company-control-loop reconcile-todos \
  --goal-id company-goal \
  --agent-id company-ceo \
  --project /path/to/project \
  --execute

loopx company-control-loop next-cycle --goal-id company-goal
```

`next-cycle` returns a new request object. Evidence-backed completed work leaves
the active frontier. Failures and missing evidence become typed feedback and
set `replan_required`. When no work remains, `goal_converged` is true.

Review the returned state before saving it as the next cycle. Revision checks
prevent an older planner or restarted worker from overwriting newer state.

## Always-on operation

An always-on host should run the ordinary LoopX heartbeat contract. Each wake
must enter through `quota should-run`, advance only the selected Todo, validate
the result, write state, and spend the matching slot. Scheduler cadence and
human notification remain host responsibilities; this command does not create
an independent hidden scheduler.
