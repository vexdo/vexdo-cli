# Contributing to vexdo

## 1) Development setup

```bash
git clone <repo-url>
cd vexdo-cli
npm install
npm link
npm test
```

Useful checks:
- `npm run typecheck`
- `npm run lint`
- `npm run build`

## 2) Project structure

```text
src/
  index.ts            # CLI entrypoint and command registration
  commands/           # User-facing command handlers
  lib/                # Core orchestration, integrations, and helpers
  prompts/            # Claude reviewer/arbiter prompt templates
  types/              # Shared TypeScript types
test/ + tests/        # Unit and integration tests
```

## 3) Adding a new command

1. Create `src/commands/<name>.ts`.
2. Export `register<Name>Command(program: Command)`.
3. Implement `run<Name>` function and keep side effects inside command layer.
4. Add registration in `src/index.ts`.
5. Add unit tests for parsing/behavior and integration tests if command touches git/fs/process.
6. Update README command docs.

## 4) Testing conventions

- **Unit tests**: isolated logic, heavy mocking (`child_process`, SDK clients, filesystem helpers).
- **Integration tests**: flow-level behavior and state transitions.
- Prefer deterministic fixtures and temporary directories.
- External dependencies (Anthropic, gh, codex) must be mocked in unit tests.

## 5) Commit conventions

- Follow Conventional Commits, e.g.:
  - `feat: add init command`
  - `fix: prevent duplicate gitignore entry`
  - `docs: expand README`
- PRs should include:
  - clear summary
  - tests run
  - any breaking changes

## 6) Release process

1. Bump version and update changelog/release notes.
2. Push tag `vX.Y.Z`.
3. GitHub Actions CI runs lint/typecheck/test/build.
4. Release job publishes to npm using `NPM_TOKEN`.
