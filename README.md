# vexdo

Automated implementation + review loop for multi-service tasks, powered by Codex Cloud and Claude.

![CI](https://github.com/vexdo/vexdo-cli/actions/workflows/ci.yml/badge.svg)
![npm](https://img.shields.io/npm/v/@vexdo/cli)
![license](https://img.shields.io/npm/l/@vexdo/cli)
![node](https://img.shields.io/node/v/@vexdo/cli)

## 1) What is vexdo

`vexdo` is a CLI that turns a task spec into a controlled execution pipeline across one or more services. It submits changes to Codex Cloud, reviews with GitHub Copilot and Claude, loops until quality gates are met, and then opens PRs (or escalates when needed).

Real-world example: you need to add a new billing field in API, web, and worker repos. Instead of running separate ad-hoc sessions, you define one `task.yml` with ordered steps and let `vexdo` orchestrate execution + review with traceable state.

## 2) How it works

```text
task.yml
   ↓
vexdo start
   ↓
codex cloud submit          ← each service step runs in an isolated cloud sandbox
   ↓
codex cloud poll
   ↓
copilot reviewer            ← reads diff with full repo context
   ↓
claude arbiter              ← decides: submit / fix / escalate
   ↓
fix loop (max N iterations)
   ↓
PR or escalate
```

Steps without cross-service dependencies run **concurrently**. Multiple steps for the same service run **sequentially in the same branch**, building on each other's output.

## 3) Requirements

- Node.js >= 18
- `ANTHROPIC_API_KEY` environment variable
- Codex CLI installed globally:
  - `npm install -g @openai/codex`
- GitHub CLI installed:
  - https://cli.github.com

## 4) Quick start (5 minutes)

```bash
npm install -g @vexdo/cli
cd my-project
vexdo init
# create tasks/backlog/my-task.yml  (or use /vexdo-spec in Claude Code)
vexdo start tasks/backlog/my-task.yml
```

`vexdo init` also installs a `/vexdo-spec` skill into Claude Code (`.claude/commands/vexdo-spec.md`) that guides writing well-formed task specs.

## 5) Commands

| Command | Description |
|---|---|
| `vexdo init` | Initialize `.vexdo.yml`, folders, `.gitignore` entry, and Claude Code skill. |
| `vexdo start <task-file> [--resume]` | Start a task and run implementation/review orchestration. |
| `vexdo review` | Re-run review loop for the current step. |
| `vexdo fix <feedback>` | Send targeted feedback to Codex, then review again. |
| `vexdo submit` | Create PRs for active task branches. |
| `vexdo status` | Show current task state. |
| `vexdo logs [task-id] [--full]` | Inspect iteration logs. |
| `vexdo board` | Open task board TUI. |
| `vexdo abort [--force]` | Abort active task and move task file back to backlog. |

### Global flags

- `--verbose`: Print debug logs.
- `--dry-run`: Show actions without making changes.

### Command details

#### `vexdo init`
Interactive bootstrap wizard:
- asks service names/paths
- asks review and model defaults
- writes `.vexdo.yml`
- creates `tasks/*` lanes and `.vexdo/logs/`
- adds `.vexdo/` to `.gitignore` once
- installs `/vexdo-spec` Claude Code skill at `.claude/commands/vexdo-spec.md`

#### `vexdo start <task-file>`
Flags:
- `--resume`: resume from existing state if present

Behavior:
- validates config and task
- creates service branches (one branch per service, shared across sequential steps)
- runs Codex Cloud then review loop per step
- independent services run concurrently; same-service steps run sequentially in the same branch
- moves task files across lanes (`backlog → in_progress → review/done/blocked`)

#### `vexdo review`
Runs review + arbiter flow against current step without restarting full task.

#### `vexdo fix <feedback>`
Runs Codex with your corrective feedback, then re-enters review loop.

#### `vexdo submit`
Creates one PR per service branch in the active task and marks task as done.

#### `vexdo status`
Prints a concise summary of active task id/title/step statuses.

#### `vexdo logs [task-id]`
Flags:
- `--full`: include full diffs and complete comment payloads

#### `vexdo abort`
Flags:
- `--force`: skip confirmation prompt

## 6) Task YAML format

```yaml
id: billing-vat-001
title: "Add VAT ID support"

steps:
  - service: api
    spec: |
      Add vat_id to organization model and migration.
      Ensure validation rules are updated.

  - service: api          # same service = continues in the same branch
    depends_on: [web]     # optional: wait for another service first
    spec: |
      Expose vat_id in the public API response and update API docs.

  - service: web
    depends_on: [api]     # waits for ALL api steps to complete
    spec: |
      Add VAT ID input to organization settings screen.
      Integrate with updated API and show validation errors.
```

**Same-service steps** share one branch and run sequentially in definition order — no `depends_on` needed between them. One PR is created per service at the end.

**Cross-service `depends_on`** references a service name and waits for all steps of that service to complete before starting.

Field reference:
- `id` *(string, required)*: stable slug used for branches and state.
- `title` *(string, required)*: human-readable name.
- `steps` *(array, required)*: ordered units of work.
  - `service` *(string, required)*: must match a `.vexdo.yml` service name.
  - `spec` *(string, required)*: concrete implementation request for Codex.
  - `depends_on` *(string[], optional)*: service names that must fully complete before this step starts.

## 7) `.vexdo.yml` format

```yaml
version: 1
services:
  - name: api
    path: ./api
    env_id: codex-env-abc123   # optional: Codex Cloud environment ID
  - name: web
    path: ./web

review:
  model: claude-haiku-4-5-20251001
  max_iterations: 3
  auto_submit: false

codex:
  model: gpt-4o
  base_branch: main

maxConcurrent: 2   # optional: limit parallel service executions
```

Field reference:
- `version`: config schema version (currently `1`).
- `services`: list of service roots used by task steps.
  - `name`: service identifier, referenced in task `steps`.
  - `path`: path to the service directory relative to project root.
  - `env_id` *(optional)*: Codex Cloud environment ID for this service.
- `review.model`: Claude model for the arbiter.
- `review.max_iterations`: hard cap for fix/review loop.
- `review.auto_submit`: auto-run `submit` after successful review.
- `codex.model`: model passed to Codex Cloud.
- `codex.base_branch`: base branch for new task branches (default: `main`).
- `maxConcurrent` *(optional)*: max number of service groups running in parallel.

## 8) Spec format guide

Good specs are:
- **specific**: list exact files, behaviors, and edge cases.
- **testable**: include acceptance checks.
- **constrained**: mention prohibited changes and compatibility limits.

Recommended template:

```text
Goal:
Constraints:
Acceptance criteria:
- ...
- ...
Non-goals:
```

Use the `/vexdo-spec` Claude Code skill to generate specs interactively.

## 9) Troubleshooting

- **"Not inside a vexdo project"**
  - Run from a directory containing `.vexdo.yml` (or use `vexdo init`).
- **Anthropic key errors**
  - Ensure `ANTHROPIC_API_KEY` is exported in shell/CI.
- **Codex not found**
  - Install with `npm install -g @openai/codex` and verify PATH.
- **`vexdo submit` fails with GitHub auth issues**
  - Run `gh auth login` and confirm repo access.
- **Task escalated**
  - Review `.vexdo/logs/*` and rerun with `vexdo fix "..."`.

## 10) Roadmap

### Review and verification

- **Verification ladder** — structured must-haves in task YAML (`must_haves: [...]`).
  Arbiter verifies each requirement against the diff at four tiers: static (file/export
  presence), command (tests pass), behavioral (observable output), or human (escalate).
  Submit is only allowed when all must-haves pass.

- **Stuck detection** — if Codex produces the same diff twice, a diagnostic retry fires
  with a targeted prompt. On a second identical diff, the loop escalates with a structured
  diagnostic showing exactly which review comments were not addressed.

### Context and memory

- **Fresh context injection** — before each Codex submission, prepend summaries of
  completed steps and the decisions register to the prompt. Prevents Codex from
  re-implementing utilities already built by earlier steps. Capped at 2000 tokens.

- **Decisions register** — `.vexdo/decisions.md`: an append-only table of architectural
  decisions made during execution (validation library, storage strategy, naming conventions).
  Arbiter populates it automatically; injected into every subsequent step prompt.

- **Scout agent** — a focused Claude call before Codex submission that scans the target
  service's codebase and returns relevant existing files, reuse hints, and conventions to
  follow. Non-fatal: if Scout fails, execution continues without it.

- **Adaptive replanning** — after each step completes, a lightweight Claude call checks
  whether remaining step specs are still accurate. Proposes updates for developer
  confirmation before the next step runs.

### Resilience

- **Continue-here protocol** — `.vexdo/continue.md` checkpoint written at every major
  phase transition (codex submitted, codex done, review iteration, arbiter done).
  `vexdo start --resume` reads the checkpoint and resumes from the exact saved position
  rather than re-entering the step from the beginning.

### Observability and interaction

- **Cost and token tracking** — every Claude API call captures token usage and estimated
  cost. Per-step and total costs are shown in `vexdo status`. Optional budget ceiling in
  `.vexdo.yml` pauses execution before overspending.

- **UAT script generation** — after all steps complete, Vexdo writes `.vexdo/uat.md`:
  a human test script derived from step must-haves and Arbiter summaries. `vexdo submit`
  warns if UAT items are unchecked (override with `--skip-uat`).

- **Discuss command** — `vexdo discuss <task-id>` opens an interactive Claude session
  with full task context pre-loaded. Ask questions about what was built, queue spec
  updates for pending steps, steer execution from a second terminal while `start` runs.

## 11) Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## 12) License

MIT.
