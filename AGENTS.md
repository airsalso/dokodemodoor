# Repository Guidelines

## Project Structure & Module Organization
- `dokodemodoor.mjs` is the main CLI entrypoint (ESM). Core logic lives in `src/` with submodules such as `src/ai/`, `src/cli/`, `src/config/`, and `src/phases/`.
- `mcp-server/` is a companion service with its own `package.json` and dependencies.
- Runtime artifacts are written to `audit-logs/`, `deliverables/`, and `repos/`; treat these as generated outputs.
- Configuration lives in `configs/` (e.g., `configs/juiceshop-config.yaml`). Prompts are in `prompts-openai/`.

## Build, Test, and Development Commands
- `npm run build` or `make build`: installs root deps and `mcp-server` deps.
- `npm start`: runs `./dokodemodoor.mjs` directly.
- `make run`: executes `./run.sh` (example invocation with a target URL and config).
- `npm run translate-report` or `make translate`: runs `scripts/translate-report.mjs`.
- `npm run clean` or `make clean`: clears generated artifacts (`audit-logs/`, `deliverables/`, `repos/`, etc.).

## Coding Style & Naming Conventions
- JavaScript uses ESM imports/exports and 2-space indentation (match existing files in `src/`).
- Prefer descriptive, domain-specific filenames (e.g., `queue-validation.js`, `progress-indicator.js`).
- Keep CLI flows in `src/cli/` and shared utilities in `src/utils/`.

## Testing Guidelines
- No first-party test runner is configured and there is no `test` script.
- If you add tests, introduce a `test/` directory and wire an npm script (e.g., `npm run test`) in the same PR.

## Commit & Pull Request Guidelines
- Recent commits use short, imperative, sentence-case subjects (e.g., “Handle README case in read_file”).
- PRs should describe the change, list manual validation steps (if any), and call out impacts on generated outputs or configs.

## Security & Configuration Tips
- Store secrets in `.env` and avoid committing values; reference config files under `configs/` instead.
- Generated outputs in `audit-logs/`, `deliverables/`, and `repos/` should not be edited manually unless debugging.
