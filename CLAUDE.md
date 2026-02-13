# CLAUDE.md

## Project Overview

DokodemoDoor (どこでもドア) is an AI agent-based autonomous penetration testing platform. It automates the full security assessment pipeline — from static analysis and reconnaissance through vulnerability analysis, exploitation, and report generation — using 28 specialized LLM-powered agents (22 web pentest + 6 reverse engineering).

## Tech Stack

- **Runtime**: Node.js 18+ with ESM modules
- **Language**: JavaScript (`.mjs` / `.js`)
- **LLM Integration**: OpenAI SDK (compatible with vLLM and OpenAI endpoints)
- **Key Dependencies**: zx (shell), chalk (terminal UI), js-yaml, zod/ajv (validation), dotenv, mcp-remote
- **MCP Server**: Separate Node.js process in `mcp-server/` using `@anthropic-ai/claude-agent-sdk`
- **External Tools**: Playwright (browser automation), Git (checkpoints), Semgrep, OSV scanner, Schemathesis (API fuzzing), Ghidra (RE static analysis), Sigcheck/DiE (RE inventory)

## Project Structure

```
dokodemodoor.mjs          # CLI entrypoint
src/                      # Core logic
  ai/                     # LLM providers, agent executor, tool registry
    tools/                # MCP proxy, tool executor, metrics
    providers/            # vLLM provider implementation
  phases/                 # Phase implementations (pre-recon, reporting, osv)
  cli/                    # CLI args, prompts, UI, command handler
  config/                 # Config loader, env
  utils/                  # Concurrency, git, metrics, formatters, context compression
  audit/                  # Audit logging, metrics tracker
  prompts/                # Prompt manager
  setup/                  # Environment setup
  checkpoint-manager.js   # Phase orchestration & git checkpoints
  session-manager.js      # Session lifecycle & agent tracking
  constants.js            # Agent validators, tool mappings, MCP agent mapping
  queue-validation.js     # Vuln queue & deliverable validation
  error-handling.js       # Global error handling
mcp-server/               # MCP tool server
  src/
    tools/                # bash, playwright, file I/O, search, TOTP, task-agent
    types/                # Deliverable types, tool response types
    utils/                # Shell utils, file operations, error formatting
    validation/           # Evidence, queue, TOTP validators
prompts-openai/           # 23 prompt templates (per-agent)
  shared/                 # 15 reusable prompt fragments (_rules, _target, etc.)
configs/                  # YAML configs + JSON schema
  profile/                # Target profiles (e.g., juice-shop.yaml)
  mcp/                    # MCP server configs
scripts/                  # Utility scripts
  translate-report.mjs    # Translate reports to Korean
  generate-project-profile.mjs  # Auto-generate target profile YAML
  project-analyzer.mjs    # Analyze project structure
  export-metrics.js       # Export session metrics
  validate-phase-tools.mjs # Validate phase tool requirements
  osv-scanner.mjs         # OSV scanner wrapper
  semgrep-analyzer.mjs    # Semgrep analysis wrapper
re-scanner.mjs            # RE pipeline CLI entrypoint
mcp-servers/              # Standalone MCP tool servers
  re-sigcheck-mcp/        # Sigcheck/DiE binary inventory MCP
  re-ghidra-mcp/          # Ghidra headless static analysis MCP
docs/                     # Architecture docs, sample flows (per vuln type)
*.sh                      # Shell scripts (run.sh, clean.sh, osv_run.sh, status.sh)
```

**Runtime-generated directories** (gitignored): `deliverables/`, `audit-logs/`, `sessions/`, `repos/`

## Build & Run

```bash
# Install dependencies
npm run build

# Run full pipeline
./dokodemodoor.mjs "http://target:3000" "/path/to/repo" --config configs/my-app.yaml

# Run specific phase or agent
./dokodemodoor.mjs ... --phase vulnerability-analysis
./dokodemodoor.mjs ... --agent sqli-vuln

# Resume interrupted session
./dokodemodoor.mjs ... --resume <session-id>

# Rollback and re-run a failed agent
./dokodemodoor.mjs ... --rerun sqli-vuln

# Generate target profile from source code
npm run generate-project-profile
npm run project-analyzer

# Translate report to Korean
npm run translate-report

# Clean runtime artifacts
npm run clean

# Reverse Engineering pipeline
npm run re-scan -- "C:\path\to\binary.exe" --config configs/profile/sample-re.yaml
```

## Coding Conventions

- **ESM imports** (`import ... from`), semicolons, 2-space indentation
- **Filenames**: `kebab-case` (e.g., `checkpoint-manager.js`)
- **Functions**: Small and focused; JSDoc comments where non-obvious
- **No linter/formatter configured** — match existing style in `src/`
- **Comments & documentation**: Project uses Korean for commit messages, user-facing text, and docs
- **Code comments**: Use Korean `[목적]` / `[호출자]` annotation style for JSDoc

## Architecture Key Points

- **28 agents** organized into 7 web phases + 5 RE phases:
  1. **Pre-Recon** — `pre-recon-code` (static code analysis)
  2. **Recon** — `recon`, `recon-verify`, `login-check` (runtime discovery & auth verification)
  3. **API Fuzzing** — `api-fuzzer` (Schemathesis-based)
  4. **Vuln Analysis** — 8 parallel agents: sqli, codei, ssti, pathi, xss, auth, ssrf, authz
  5. **Exploitation** — 8 parallel agents (matching vuln types)
  6. **Reporting** — `report-executive` (comprehensive assessment)
  7. **OSV Analysis** — `osv-analysis` (SCA/dependency vulnerabilities)
- **Reverse Engineering pipeline** (standalone via `re-scanner.mjs`):
  1. **RE Inventory** — `re-inventory` (Sigcheck/DiE binary triage)
  2. **RE Static** — `re-static` (Ghidra decompilation & observation candidates)
  3. **RE Dynamic** — `re-dynamic` + `re-instrument` (ProcMon/WinDbg + Frida, parallel)
  4. **RE Network** — `re-network` (tshark traffic analysis)
  5. **RE Report** — `re-report` (comprehensive RE assessment)
- **Git checkpoint system**: Each agent completion creates a git commit, enabling `--rerun` rollback
- **Queue-based exploitation**: Analysis agents output JSON queues consumed by exploitation agents
- **MCP agent mapping**: Agents mapped to specific Playwright instances to prevent browser conflicts (`constants.js:MCP_AGENT_MAPPING`)
- **Phase-based tool requirements**: Playwright only launched for phases that need it (`PHASE_TOOL_REQUIREMENTS`)
- **Session state**: JSON files in `sessions/`, no database
- **Context compression**: Automatic message trimming when approaching token limits (configurable threshold/window)
- **Cumulative analysis**: Phases reuse results from prior scans (archived deliverables)
- **SessionMutex**: Thread-safe concurrent operations across parallel agents
- **Agent validators**: Each agent has a validator ensuring required deliverables exist before checkpoint commit

## Configuration

- Target configs are YAML files validated against `configs/config-schema.json`
- Environment variables go in `.env` (see `.env.example`)
- Key env vars:
  - **LLM**: `DOKODEMODOOR_LLM_PROVIDER`, `VLLM_BASE_URL`, `VLLM_MODEL`, `VLLM_API_KEY`, `VLLM_TEMPERATURE`
  - **Turns**: `VLLM_MAX_TURNS` (global), `DOKODEMODOOR_*_MAX_TURNS` (per-agent overrides)
  - **Context**: `DOKODEMODOOR_CONTEXT_COMPRESSION_THRESHOLD`, `DOKODEMODOOR_CONTEXT_COMPRESSION_WINDOW`
  - **Execution**: `DOKODEMODOOR_PARALLEL_LIMIT`, `DOKODEMODOOR_SKIP_EXPLOITATION`
  - **Tool skips**: `DOKODEMODOOR_SKIP_NMAP`, `DOKODEMODOOR_SKIP_SEMGREP`, `DOKODEMODOOR_SKIP_OSV`, etc.
  - **Debug**: `DOKODEMODOOR_DEBUG`, `DOKODEMODOOR_AGENT_DEBUG_LOG`, `DOKODEMODOOR_PRINT_LOG_PROMPT_SIZES`
  - **External**: `EXTERNAL_TEST_DOMAIN` (out-of-band/SSRF testing)

## Testing

- No automated test framework. Validate by running against known targets (e.g., OWASP Juice Shop) and inspecting `deliverables/` and `audit-logs/` output.

## Commit Style

- Automated runs use checkpoint-style: `Checkpoint: <Agent/Step>`
- Feature work uses short imperative messages (Korean)
