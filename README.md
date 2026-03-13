# vexdo

Automated implementation + review loop for multi-service tasks, powered by Codex and Claude.

![CI](https://github.com/vexdo/vexdo-cli/actions/workflows/ci.yml/badge.svg)
![npm](https://img.shields.io/npm/v/vexdo)
![license](https://img.shields.io/npm/l/vexdo)
![node](https://img.shields.io/node/v/vexdo)

## 1) What is vexdo

`vexdo` is a CLI that turns a task spec into a controlled execution pipeline across one or more services. It applies changes with Codex, reviews with Claude, loops until quality gates are met, and then opens PRs (or escalates when needed).

Real-world example: you need to add a new billing field in API, web, and worker repos. Instead of running separate ad-hoc sessions, you define one `task.yml` with ordered steps and let `vexdo` orchestrate execution + review with traceable state.

## 2) How it works

```text
task.yml
   ↓
vexdo start
   ↓
codex exec
   ↓
git diff
   ↓
claude reviewer
   ↓
claude arbiter
   ↓
fix loop (max N)
   ↓
PR or escalate
```

## 3) Requirements

- Node.js >= 18
- `ANTHROPIC_API_KEY` environment variable
- Codex CLI installed globally:
  - `npm install -g @openai/codex`
- GitHub CLI installed:
  - https://cli.github.com

## 4) Quick start (5 minutes)

```bash
npm install -g @vexdo/cli@0.1.0
cd my-project
vexdo init
# create tasks/backlog/my-task.yml
vexdo start tasks/backlog/my-task.yml
```

## 5) Commands

| Command | Description |
|---|---|
| `vexdo init` | Initialize `.vexdo.yml`, folders, and `.gitignore` entry. |
| `vexdo start <task-file> [--resume]` | Start a task and run implementation/review orchestration. |
| `vexdo review` | Re-run review loop for the current step. |
| `vexdo fix <feedback>` | Send targeted feedback to Codex, then review again. |
| `vexdo submit` | Create PRs for active task branches. |
| `vexdo status` | Show current task state. |
| `vexdo logs [task-id] [--full]` | Inspect iteration logs. |
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

#### `vexdo start <task-file>`
Flags:
- `--resume`: resume from existing state if present

Behavior:
- validates config and task
- creates/checks service branches
- runs Codex then review loop per step
- moves task files across lanes (`backlog → in_progress → review/done/blocked`)

#### `vexdo review`
Runs review + arbiter flow against current step without restarting full task.

#### `vexdo fix <feedback>`
Runs Codex with your corrective feedback, then re-enters review loop.

#### `vexdo submit`
Creates PRs for each service branch in the active task and marks task as done.

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
depends_on: [] # optional task-level dependencies

steps:
  - service: api
    spec: |
      Add vat_id to organization model, migration, and create/update APIs.
      Ensure validation rules and API docs are updated.

  - service: web
    depends_on: [api] # optional per-step ordering dependency
    spec: |
      Add VAT ID input to organization settings screen.
      Integrate with updated API and show validation errors.
```

Field reference:
- `id` *(string, required)*: stable slug used for branches and state.
- `title` *(string, required)*: human-readable name.
- `depends_on` *(string[], optional)*: coarse dependency marker at task level.
- `steps` *(array, required)*: ordered units of work.
  - `service` *(string, required)*: must match `.vexdo.yml` service name.
  - `spec` *(string, required)*: concrete implementation request for Codex.
  - `depends_on` *(string[], optional)*: service dependencies before this step starts.

## 7) `.vexdo.yml` format

```yaml
version: 1
services:
  - name: api
    path: ./api
  - name: web
    path: ./web

review:
  model: claude-haiku-4-5-20251001
  max_iterations: 3
  auto_submit: false

codex:
  model: gpt-4o
```

Field reference:
- `version`: config schema version (currently `1`).
- `services`: list of service roots used by task steps.
- `review.model`: Claude model for reviewer + arbiter.
- `review.max_iterations`: hard cap for fix/review loop.
- `review.auto_submit`: auto-run `submit` after successful review.
- `codex.model`: model passed to Codex execution.

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

Vexdo currently runs tasks sequentially using a local Codex subprocess. The next major
evolution moves toward cloud-native execution and parallel orchestration.

### Codex Cloud execution

Replace local `codex exec` with **Codex Cloud** (`codex cloud exec`). Each task step runs
in an isolated cloud sandbox with direct GitHub repository access — no local git state
required. The orchestrator submits tasks, polls for completion, retrieves diffs via
`codex cloud diff`, and uses `codex cloud exec resume` to continue the same session on
fix iterations. This eliminates conflicts between parallel tasks and removes the dependency
on a clean local working tree.

### Parallel step execution

Once isolation is handled by Codex Cloud, steps without `depends_on` relationships can
run concurrently. A worker pool dispatches all unblocked steps simultaneously and waits
for dependencies before starting dependent ones. A task touching three services can
complete in roughly the time of its longest step, not the sum of all.

### GitHub Copilot CLI as reviewer

Replace the Claude-based reviewer with **GitHub Copilot CLI** (`copilot --output-format=json`).
Copilot reads the local git diff with full repository context — it understands imports,
types, and related files beyond the diff itself. Claude stays as the Arbiter that decides
whether to submit, fix, or escalate based on Copilot's structured output.

### Task board TUI

A `vexdo board` command built with **Ink** (React for CLIs) that renders all task lanes
as a navigable terminal board. Keyboard shortcuts to start, edit, inspect, and abort tasks
without leaving the terminal. Live status for in-progress tasks when the orchestrator is
running.

## 11) Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## 12) License

MIT.
