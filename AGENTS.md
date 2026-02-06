# Repository Guidelines

## Project Structure & Module Organization
- `dokodemodoor.mjs` is the CLI entrypoint.
- Core logic lives in `src/` (session/agent orchestration, config loading, utilities).
- MCP tools are implemented in `mcp-server/src/`.
- Agent prompts are in `prompts-openai/` with shared fragments under `prompts-openai/shared/`.
- Runtime configuration is stored in `configs/` (YAML plus `config-schema.json`).
- Generated artifacts go to `deliverables/`, `audit-logs/`, `sessions/`, and `repos/` (all auto-created at runtime).

## Build, Test, and Development Commands
- `npm run build`: installs dependencies in the root and `mcp-server/`.
- `npm start`: runs `./dokodemodoor.mjs` (CLI entrypoint).
- `./dokodemodoor.mjs "<target-url>" "<target-repo>" --config configs/example-config.yaml`: run the full pipeline.
- `./dokodemodoor.mjs ... --phase vulnerability-analysis` or `--agent sqli-vuln`: run a subset.
- `npm run translate-report`: translate the final report using `scripts/translate-report.mjs`.
- `npm run clean`: remove generated state (`audit-logs/`, `sessions/`, `deliverables/`, `repos/`).

## Coding Style & Naming Conventions
- JavaScript uses ESM (`import ... from`), semicolons, and 2-space indentation.
- Prefer descriptive filenames in `kebab-case` (e.g., `checkpoint-manager.js`).
- Keep functions small and focused; use JSDoc-style block comments where the code is non-obvious.
- No formatter or linter is configured; match existing style in `src/`.

## Testing Guidelines
- No automated test framework is currently present.
- Validate changes by running the CLI against a known target and inspecting outputs in `deliverables/` and `audit-logs/`.
- If you add tests, document how to run them here and keep them fast and deterministic.

## Commit & Pull Request Guidelines
- Recent history uses checkpoint-style commits like `Checkpoint: <Agent/Step>` (sometimes with emoji). Follow this pattern for automated runs; for feature work use short, imperative messages.
- PRs should include a concise summary, steps to reproduce, and any new/updated config paths (e.g., `configs/*.yaml`).
- Include sample outputs or screenshots when changes affect reports or UI/CLI output.

## Security & Configuration Tips
- Store secrets in `.env` (e.g., `OPENAI_API_KEY`, `VLLM_BASE_URL`) and avoid committing them.
- Treat `configs/` as executable instructions for agents; review changes carefully before running against real targets.
