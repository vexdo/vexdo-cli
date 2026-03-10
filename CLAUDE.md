# CLAUDE.md

## 1) Project overview

`vexdo` is a task orchestrator CLI for multi-service repositories. The core flow is: load task + config, run Codex for each step, run Claude reviewer + arbiter loop, then submit PRs or escalate.

## 2) Architecture

Dependency direction should stay:

```text
types  ←  lib  ←  commands  ←  index.ts
```

Key invariants:
- `commands/` may exit process; `lib/` should generally return errors.
- `lib/` is reusable orchestration/integration logic.
- `types/` stays free of runtime dependencies.
- Reviewer and arbiter must run with isolated contexts/data.

## 3) Key files and roles

```text
src/
  index.ts                  # commander bootstrap, global flags, command wiring
  commands/
    init.ts                 # interactive bootstrap (`vexdo init`)
    start.ts                # primary task execution flow
    review.ts               # rerun review loop on active step
    fix.ts                  # feed corrective prompt to Codex then review
    submit.ts               # PR creation and state completion
    abort.ts                # cancel task, preserve branches
    status.ts               # print active state
    logs.ts                 # print iteration logs
  lib/
    config.ts               # .vexdo.yml discovery + validation
    tasks.ts                # task loading/validation and lane moves
    state.ts                # active state persistence
    review-loop.ts          # reviewer/arbiter loop control
    claude.ts               # Anthropic SDK wrapper
    codex.ts                # codex CLI wrapper
    gh.ts                   # gh CLI wrapper for PRs
    git.ts                  # git operations
    logger.ts               # output formatting
    requirements.ts         # env/runtime checks
  prompts/
    reviewer.ts             # reviewer prompt construction
    arbiter.ts              # arbiter prompt construction
  types/index.ts            # shared type contracts
```

## 4) Common tasks

### Add a command
1. Add `src/commands/<name>.ts` with `register<Name>Command`.
2. Keep parsing and CLI concerns in command file.
3. Put reusable logic in `lib/`.
4. Register in `src/index.ts`.
5. Add tests and README docs.

### Add a lib function
1. Add function to the nearest `lib/*` module.
2. Keep signature typed and avoid `any`.
3. Return errors; avoid process termination.
4. Add focused unit tests.

### Add a test
1. Unit tests in `test/unit` or `tests/unit` for isolated behavior.
2. Integration tests in `test/integration` or `tests/integration` for flow.
3. Use `vi.mock` for `child_process`, SDKs, and external CLIs.

## 5) Constraints to always enforce

- No `any` in new code.
- Keep ESM `.js` import specifiers in TS source.
- No `process.exit` inside `lib/` modules.
- Do not add `chalk`; use `picocolors` for output styling.
- Reviewer and arbiter contexts must remain isolated.

## 6) Test conventions

- Prefer mocking at module boundary.
- `child_process` calls should be mocked with `vi.mock('node:child_process', ...)`.
- Anthropic SDK behavior should be mocked through `lib/claude.ts` dependencies.
- Use temp directories for filesystem side effects.

## 7) What not to do

- Do not embed orchestration logic directly in `index.ts`.
- Do not tightly couple command handlers to specific prompt text.
- Do not bypass task/config validation.
- Do not mutate state without persisting through `state.ts` helpers.
- Do not mix reviewer and arbiter outputs in a single decision context.
