import { $, fs, path } from 'zx';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Provider abstraction layer
import { getProvider } from './llm-provider.js';
import { toolRegistry, registerMCPTools } from './tools/tool-registry.js';
import { config as envConfig, isVLLMProvider } from '../config/env.js';
import { runWithContext } from '../utils/context.js';
import { isRetryableError, getRetryDelay, PentestError } from '../error-handling.js';
import { ProgressIndicator } from '../progress-indicator.js';
import { timingResults, costResults, Timer } from '../utils/metrics.js';
import { formatDuration } from '../audit/utils.js';
import { createGitCheckpoint, commitGitSuccess, rollbackGitWorkspace, getGitHeadHash } from '../utils/git-manager.js';
import { AGENT_VALIDATORS, MCP_AGENT_MAPPING, PHASE_TOOL_REQUIREMENTS, AGENT_TOOL_OVERRIDES } from '../constants.js';
import { filterJsonToolCalls, getAgentPrefix } from '../utils/output-formatter.js';
import { generateSessionLogPath, updateSession } from '../session-manager.js';
import { AuditSession } from '../audit/index.js';

import { createDokodemoDoorHelperServer } from '../../mcp-server/src/index.js';
import { getLocalISOString } from '../utils/time-utils.js';
import { spawn } from 'child_process';
import { resetProxyMetrics, trackToolCall, printProxyMetrics, saveProxyMetrics } from './tools/proxy-metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);




/**
 * [목적] PATH에서 실행 가능한 커맨드 위치를 खोज.
 *
 * [호출자]
 * - resolvePlaywrightMcpCommand() (Playwright MCP 실행 파일 탐색)
 *
 * [출력 대상]
 * - 호출자에게 실행 파일 경로 반환
 *
 * [입력 파라미터]
 * - command (string): 찾을 실행 파일 이름
 *
 * [반환값]
 * - string|null: 발견된 경로 또는 null
 *
 * [부작용]
 * - 없음 (읽기 전용)
 */
const findCommandInPath = (command) => {
  const envPath = process.env.PATH || '';
  const searchPaths = envPath.split(path.delimiter);

  for (const dir of searchPaths) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (fs.pathExistsSync(candidate)) {
      return candidate;
    }
  }

  return null;
};

/**
 * [목적] Playwright MCP 실행 커맨드와 기본 인자를 결정.
 *
 * [호출자]
 * - runAgentPrompt()에서 MCP 서버 구성 시 사용
 *
 * [출력 대상]
 * - { command, baseArgs } 객체 반환
 *
 * [반환값]
 * - object: 실행 커맨드와 기본 인자
 *
 * [주의사항]
 * - 환경변수 DOKODEMODOOR_PLAYWRIGHT_MCP_COMMAND가 우선
 */
const resolvePlaywrightMcpCommand = () => {
  const override = process.env.DOKODEMODOOR_PLAYWRIGHT_MCP_COMMAND;
  if (override) {
    const parts = override.trim().split(/\s+/).filter(Boolean);
    return { command: parts[0], baseArgs: parts.slice(1) };
  }

  if (findCommandInPath('mcp-server-playwright')) {
    return { command: 'mcp-server-playwright', baseArgs: [] };
  }

  return { command: 'npx', baseArgs: ['@playwright/mcp@latest'] };
};

/**
 * Convert agent name to prompt name for MCP_AGENT_MAPPING lookup
 *
 * @param {string} agentName - Agent name (e.g., 'xss-vuln', 'injection-exploit')
 * @returns {string} Prompt name (e.g., 'vuln-xss', 'exploit-injection')
 */
/**
 * [목적] 에이전트 이름을 프롬프트 이름으로 정규화.
 *
 * [호출자]
 * - runAgentPrompt()의 MCP_AGENT_MAPPING 조회
 *
 * [출력 대상]
 * - 프롬프트 파일명/키 문자열
 *
 * [입력 파라미터]
 * - agentName (string)
 *
 * [반환값]
 * - string: 프롬프트 키
 */
function agentNameToPromptName(agentName) {
  // Special cases
  if (agentName === 'pre-recon') return 'pre-recon-code';
  if (agentName === 'report') return 'report-executive';
  if (agentName === 'recon') return 'recon';

  // Pattern: {type}-vuln → vuln-{type}
  const vulnMatch = agentName.match(/^(.+)-vuln$/);
  if (vulnMatch) {
    return `vuln-${vulnMatch[1]}`;
  }

  // Pattern: {type}-exploit → exploit-{type}
  if (agentName.endsWith('-exploit')) {
    const exploitMatch = agentName.match(/^(.+)-exploit$/);
    if (exploitMatch) {
      return `exploit-${exploitMatch[1]}`;
    }
  }

  // Default: return as-is
  return agentName;
}

/**
 * Get the phase for a given agent name
 *
 * @param {string} agentName - Agent name (e.g., 'sqli-vuln', 'recon', 'report')
 * @returns {string|null} - Phase name or null if unknown
 */
function getAgentPhase(agentName) {
  // Phase 1: Pre-reconnaissance
  if (agentName === 'pre-recon') {
    return 'pre-reconnaissance';
  }

  // Phase 2: Reconnaissance
  if (agentName === 'recon' || agentName === 'recon-verify' || agentName === 'login-check') {
    return 'reconnaissance';
  }

  // Phase 2.5: API Fuzzing
  if (agentName === 'api-fuzzer') {
    return 'api-fuzzing';
  }

  // Phase 3: Vulnerability Analysis
  if (agentName.endsWith('-vuln')) {
    return 'vulnerability-analysis';
  }

  // Phase 4: Exploitation
  if (agentName.endsWith('-exploit')) {
    return 'exploitation';
  }

  // Phase 5: Reporting
  if (agentName === 'report') {
    return 'reporting';
  }

  // Unknown agent
  return null;
}

// Simplified validation using direct agent name mapping
/**
 * [목적] 에이전트 결과물(Deliverables) 생성 여부를 검증.
 *
 * [호출자]
 * - runAgentPromptWithRetry()에서 결과 검증 단계
 *
 * [출력 대상]
 * - 성공/실패 여부 반환
 *
 * [입력 파라미터]
 * - result (object): 에이전트 실행 결과
 * - agentName (string)
 * - sourceDir (string)
 *
 * [반환값]
 * - boolean
 *
 * [에러 처리]
 * - 예외 발생 시 false 반환
 */
async function validateAgentOutput(result, agentName, sourceDir, auditSession) {
  console.log(chalk.blue(`    🔍 Validating ${agentName} agent output`));

  // Get validator function for this agent
  const validator = AGENT_VALIDATORS[agentName];

  try {
    // Check if agent completed successfully OR if it crashed but deliverables were saved
    if (!result.success || !result.result) {
      if (validator && await validator(sourceDir)) {
        console.log(chalk.green(`    ✅ Validation passed: Agent had execution issues but deliverables are present`));
        return true;
      }
      console.log(chalk.red(`    ❌ Validation failed: Agent execution was unsuccessful and no deliverables found`));
      return false;
    }

    if (!validator) {
      console.log(chalk.yellow(`    ⚠️ No validator found for agent "${agentName}" - assuming success`));
      console.log(chalk.green(`    ✅ Validation passed: Unknown agent with successful result`));
      return true;
    }

    console.log(chalk.blue(`    📋 Using validator for agent: ${agentName}`));
    console.log(chalk.blue(`    📂 Source directory: ${sourceDir}`));

    // Apply validation function
    const sessionDir = auditSession ? auditSession.sessionDir : null;
    const validationResult = await validator(sourceDir, sessionDir);

    if (validationResult) {
      console.log(chalk.green(`    ✅ Validation passed: Required files/structure present`));
    } else {
      console.log(chalk.red(`    ❌ Validation failed: Missing required deliverable files`));
    }

    return validationResult;

  } catch (error) {
    const errorMsg = error?.message || String(error) || 'Unknown validation error';
    console.log(chalk.red(`    ❌ Validation failed with error: ${errorMsg}`));
    return false; // Assume invalid on validation error
  }
}

// Pure function: Run agent with provider - Maximum Autonomy
// WARNING: This is a low-level function. Use runAgentPromptWithRetry() for agent execution to ensure:
// - Retry logic and error handling
// - Output validation
// - Prompt snapshotting for debugging
// - Git checkpoint/rollback safety
/**
 * [목적] 단일 에이전트 프롬프트 실행(저수준 실행 루프).
 *
 * [호출자]
 * - runAgentPromptWithRetry() 내부에서 재시도 포함 실행
 *
 * [출력 대상]
 * - LLM 결과, 로그, 감사 세션 기록
 *
 * [입력 파라미터]
 * - prompt (string)
 * - sourceDir (string)
 * - allowedTools (string)
 * - context (string)
 * - description (string)
 * - agentName (string|null)
 * - colorFn (function)
 * - sessionMetadata (object|null)
 * - auditSession (object|null)
 * - attemptNumber (number)
 *
 * [반환값]
 * - Promise<object>
 *
 * [부작용]
 * - MCP 서버 실행, 로그 기록, 도구 호출 수행
 */
async function runAgentPrompt(prompt, sourceDir, allowedTools = 'Read', context = '', description = 'Agent analysis', agentName = null, colorFn = chalk.cyan, sessionMetadata = null, auditSession = null, attemptNumber = 1) {
  // Use global envConfig as base
  let config = { ...envConfig };

  // Load custom project config if configFile is present in sessionMetadata
  if (sessionMetadata && sessionMetadata.configFile) {
    try {
      const { loadConfig } = await import('../config/config-loader.js');
      const configPath = sessionMetadata.configFile;
      const configResult = await loadConfig(configPath);
      if (configResult && configResult.config) {
        // Project config overrides/merges with env config
        // Note: project config typically has top-level keys like 'mcpServers', 'rules', 'authentication'
        config = { ...config, ...configResult.config };
        console.log(chalk.gray(`    ⚙️  Applied project configuration from ${configPath}`));
      }
    } catch (err) {
      // Non-fatal, we just use the base config
      console.log(chalk.yellow(`    ⚠️  Could not load project config from session: ${err.message}`));
    }
  }

  const timer = new Timer(`agent-${description.toLowerCase().replace(/\s+/g, '-')}`);
  const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;
  let totalCost = 0;
  let partialCost = 0; // Track partial cost for crash safety

  // Auto-detect execution mode to adjust logging behavior
  const isParallelExecution = description.includes('vuln agent') || description.includes('exploit agent');
  const useCleanOutput = description.includes('Pre-recon agent') ||
                         description.includes('Recon agent') ||
                         description.includes('Executive Summary and Report Cleanup') ||
                         description.includes('vuln agent') ||
                         description.includes('exploit agent');

  // Disable status manager - using simple JSON filtering for all agents now
  const statusManager = null;

  // Reset proxy metrics for this agent execution
  resetProxyMetrics();

  // Setup progress indicator for clean output agents (unless disabled via flag)
  let progressIndicator = null;
  if (useCleanOutput && !global.DOKODEMODOOR_DISABLE_LOADER) {
    const agentType = description.includes('Pre-recon') ? 'pre-reconnaissance' :
                     description.includes('Recon') ? 'reconnaissance' :
                     description.includes('Report') ? 'report generation' : 'analysis';
    progressIndicator = new ProgressIndicator(`Running ${agentType}...`);
  }

  // NOTE: Logging now handled by AuditSession (append-only, crash-safe)
  // Legacy log path generation kept for compatibility
  let logFilePath = null;
  if (sessionMetadata && sessionMetadata.webUrl && sessionMetadata.id) {
    const timestamp = getLocalISOString().replace(/T/, '_').replace(/[:.]/g, '-').slice(0, 19);
    const auditAgentName = description.toLowerCase().replace(/\s+/g, '-');
    const logDir = generateSessionLogPath(sessionMetadata.webUrl, sessionMetadata.id);
    logFilePath = path.join(logDir, `${timestamp}_${auditAgentName}_attempt-${attemptNumber}.log`);
  } else {
    console.log(chalk.blue(`  🤖 Running DokodemoDoor Code: ${description}...`));
  }

  // Declare variables that need to be accessible in both try and catch blocks
  let turnCount = 0;

  try {
    // Register local MCP tools for vLLM provider
    if (isVLLMProvider()) {
      await registerMCPTools();
    }

    // Get LLM provider (vLLM only)
    const provider = await getProvider();
    const providerName = provider.getName();

    // Provider-specific setup
    let queryOptions = {
      cwd: sourceDir,
      maxTurns: (agentName && config.dokodemodoor.agentMaxTurns[agentName])
                  || config.llm.vllm.maxTurns
                  || 100,
      agentName: agentName,
      parentTurnCount: null  // Will be set by TaskAgent when calling sub-agents
    };

    // Determine which tools this agent needs based on phase and agent-specific overrides
    let needsPlaywright = false;

    if (agentName) {
      const promptName = agentNameToPromptName(agentName);

      // Check for agent-specific override first
      if (AGENT_TOOL_OVERRIDES[promptName]) {
        needsPlaywright = AGENT_TOOL_OVERRIDES[promptName].playwright;
        console.log(chalk.gray(`    🎯 Agent-specific tools for ${agentName}: Playwright=${needsPlaywright}`));
      } else {
        // Fall back to phase-based requirements
        const agentPhase = getAgentPhase(agentName);
        if (agentPhase && PHASE_TOOL_REQUIREMENTS[agentPhase]) {
          needsPlaywright = PHASE_TOOL_REQUIREMENTS[agentPhase].playwright;
          console.log(chalk.gray(`    📦 Phase-based tools for ${agentName} (${agentPhase}): Playwright=${needsPlaywright}`));
        } else {
          // Default: enable all tools for unknown agents (safety fallback)
          needsPlaywright = true;
          console.log(chalk.yellow(`    ⚠️  Unknown phase for ${agentName}, enabling all tools by default`));
        }
      }
    }

    // Determine agent's assigned Playwright MCP server (only if needed)
    let playwrightMcpName = null;
    if (agentName && needsPlaywright) {
      const promptName = agentNameToPromptName(agentName);
      playwrightMcpName = MCP_AGENT_MAPPING[promptName];

      if (playwrightMcpName) {
        console.log(chalk.gray(`    🎭 Assigned ${agentName} → ${playwrightMcpName}`));
      }
    } else if (agentName && !needsPlaywright) {
      console.log(chalk.gray(`    ⏭️  Skipping Playwright for ${agentName} (not needed for this phase)`));
    }

    // Configure MCP servers config (dokodemodoor-helper + playwright-agentN)
    const mcpServersConfig = {};

    // 1. DokodemoDoor helper (Local tools like save_deliverable)
    mcpServersConfig['dokodemodoor-helper'] = {
      type: 'dokodemodoor-helper',
      targetDir: sourceDir
    };

    // 2. Playwright MCP server (Stdio) - only if needed
    if (playwrightMcpName) {
      const userDataDir = `/tmp/${playwrightMcpName}`;
      const { command: mcpCommand, baseArgs } = resolvePlaywrightMcpCommand();
      const mcpArgs = [
        ...baseArgs,
        '--isolated',
        '--user-data-dir', userDataDir,
        '--timeout-action', '30000',
        '--timeout-navigation', '60000'
      ];

      if (config.dokodemodoor.playwrightHeadless) {
        mcpArgs.push('--headless');
      }

      mcpServersConfig[playwrightMcpName] = {
        type: 'stdio',
        command: mcpCommand,
        args: mcpArgs,
        env: {
          ...process.env,
          PLAYWRIGHT_HEADLESS: config.dokodemodoor.playwrightHeadless ? 'true' : 'false'
        },
        cwd: sourceDir
      };
    }





    // 3. Add any custom MCP servers defined in configuration
    if (config.mcpServers) {
      for (const [name, srvConfig] of Object.entries(config.mcpServers)) {
        if (!mcpServersConfig[name]) {
          console.log(chalk.gray(`    🔌 Mapping custom MCP server: ${name}`));
          mcpServersConfig[name] = srvConfig;
        }
      }
    }

    // Provider-specific setup
    if (isVLLMProvider()) {
      // For vLLM, we manually register remote tools via our proxy
      const { registerRemoteMCPTools } = await import('./tools/tool-registry.js');
      await registerRemoteMCPTools(mcpServersConfig);
    }

    // SDK Options only shown for verbose agents (not clean output)
    if (!useCleanOutput) {
      console.log(chalk.gray(`    Provider: ${providerName}, maxTurns=${queryOptions.maxTurns}, cwd=${sourceDir}`));
    }

    let result = null;
    let messages = [];
    let apiErrorDetected = false;

    // Start progress indicator for clean output agents
    if (progressIndicator) {
      progressIndicator.start();
    }


    let messageCount = 0;
    let lastHeartbeat = Date.now();
    const HEARTBEAT_INTERVAL = 30000; // 30 seconds
    const parentTurnCount = queryOptions.parentTurnCount || null;  // Get parent turn count for sub-agents

    try {
      // Use provider's query method
      // Wrap the entire query turn in context to isolate state
      await runWithContext({
        agentName: agentName || description,
        targetDir: sourceDir,
        auditSession,
        webUrl: sessionMetadata?.webUrl || null
      }, async () => {
        for await (const message of provider.query(fullPrompt, queryOptions)) {
          messageCount++;

          // Periodic heartbeat for long-running agents
          const now = Date.now();
          if (now - lastHeartbeat > HEARTBEAT_INTERVAL) {
            // 1. Log heartbeat to console if loader is disabled
            if (global.DOKODEMODOOR_DISABLE_LOADER) {
              const isSubAgent = description.toLowerCase().includes('sub-agent') || description.toLowerCase().includes('taskagent');
              const turnDisplay = isSubAgent && parentTurnCount ? `Turn ${parentTurnCount}-${turnCount}` : `Turn ${turnCount}`;
              const turnColor = isSubAgent ? chalk.cyan : chalk.blue;
              console.log(turnColor(`    ⏱️  [${Math.floor((now - timer.startTime) / 1000)}s] ${description} running... (${turnDisplay})`));
            }

            // 2. Update session heartbeat in store to prevent stale detection
            if (sessionMetadata && sessionMetadata.id) {
              updateSession(sessionMetadata.id, { lastActivity: getLocalISOString() }).catch(() => {});
            }

            lastHeartbeat = now;
          }


          if (message.type === "assistant") {
            turnCount++;

            const content = Array.isArray(message.message.content)
              ? message.message.content.map(c => c.text || JSON.stringify(c)).join('\n')
              : message.message.content || '';

            const cleanedContent = content.replace(/```[\s\S]*?```/g, '[code block]').substring(0, 200);

            // Show turn information based on loader state
            // If loader is disabled, always show full output regardless of useCleanOutput
            const showFullOutput = global.DOKODEMODOOR_DISABLE_LOADER || !useCleanOutput;

            if (showFullOutput) {
              // Determine turn level and color
              const descLower = description.toLowerCase();
              let turnColorFn;
              if (descLower.includes('sub-agent') || descLower.includes('taskagent')) {
                // Level 2: Sub-agent (Magenta)
                turnColorFn = chalk.magenta;
              } else {
                // Level 1: Phase / Main Agent (Blue)
                turnColorFn = chalk.blue;
              }

              // Full streaming output - show complete messages with specialist color
              const isSubAgent = descLower.includes('sub-agent') || descLower.includes('taskagent');
              const turnDisplay = isSubAgent && parentTurnCount ? `Turn ${parentTurnCount}-${turnCount}` : `Turn ${turnCount}`;
              console.log(turnColorFn(`\n    🤖 ${turnDisplay} (${description}):`));
              console.log(turnColorFn(`    ${content}`));
            } else if (statusManager) {
              // Smart status updates for parallel execution
              const toolUse = statusManager.parseToolUse(content);
              statusManager.updateAgentStatus(description, {
                turn: turnCount,
                action: toolUse || 'thinking',
                timestamp: Date.now()
              });
            } else if (useCleanOutput) {
              // Compact output for clean agents
              if (content.length > 0) {
                // Temporarily stop progress indicator to show output
                if (progressIndicator) {
                  progressIndicator.stop();
                }

                if (isParallelExecution) {
                  // Compact output for parallel agents with prefixes
                  const prefix = getAgentPrefix(description);
                  console.log(colorFn(`${prefix} ${cleanedContent}`));
                } else {
                  // Full turn output for single agents
                  const isSubAgent = description.toLowerCase().includes('sub-agent') || description.toLowerCase().includes('taskagent');
                  const turnDisplay = isSubAgent && parentTurnCount ? `Turn ${parentTurnCount}-${turnCount}` : `Turn ${turnCount}`;
                  const turnColorFn = isSubAgent ? chalk.cyan : colorFn;
                  console.log(turnColorFn(`\n    🤖 ${turnDisplay} (${description}):`));
                  console.log(turnColorFn(`    ${cleanedContent}`));
                }

                // Restart progress indicator after output
                if (progressIndicator) {
                  progressIndicator.start();
                }
              }
            }

            // Log to audit system (crash-safe, append-only)
            if (auditSession) {
              await auditSession.logEvent('llm_response', {
                turn: turnCount,
                content,
                timestamp: getLocalISOString()
              });
            }

            messages.push(content);

            // Check for API error patterns in assistant message content
            if (content && typeof content === 'string') {
              const lowerContent = content.toLowerCase();
              if (lowerContent.includes('session limit reached')) {
                throw new PentestError('Session limit reached', 'billing', false);
              }
              if (lowerContent.includes('api error') || lowerContent.includes('terminated')) {
                apiErrorDetected = true;
                console.log(chalk.red(`    ⚠️  API Error detected in assistant response: ${content.trim()}`));
              }
            }

          } else if (message.type === "system" && message.subtype === "init") {
            // Show useful system info only for verbose agents
            if (!useCleanOutput) {
              console.log(chalk.blue(`    ℹ️  Model: ${message.model}, Permission: ${message.permissionMode}`));
              if (message.mcp_servers && message.mcp_servers.length > 0) {
                const mcpStatus = message.mcp_servers.map(s => `${s.name}(${s.status})`).join(', ');
                console.log(chalk.blue(`    📦 MCP: ${mcpStatus}`));
              }
            }

          } else if (message.type === "user") {
            // Skip user messages (these are our own inputs echoed back)
            continue;

          } else if (message.type === "tool_use") {
            console.log(chalk.yellow(`\n    🔧 Using Tool: ${message.name}`));
            if (message.input && Object.keys(message.input).length > 0) {
              console.log(chalk.gray(`    Input: ${JSON.stringify(message.input, null, 2)}`));
            }

            // Log tool start event
            if (auditSession) {
              await auditSession.logEvent('tool_start', {
                toolName: message.name,
                parameters: message.input,
                timestamp: getLocalISOString()
              });
            }
          } else if (message.type === "tool_result") {
            console.log(chalk.green(`    ✅ Tool Result:`));
            if (message.content) {
              // Show tool results but truncate if too long
              const resultStr = typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2);
              if (resultStr.length > 500) {
                console.log(chalk.gray(`    ${resultStr.slice(0, 500)}...\n    [Result truncated - ${resultStr.length} total chars]`));
              } else {
                console.log(chalk.gray(`    ${resultStr}`));
              }
            }

            // Log tool end event
            if (auditSession) {
              await auditSession.logEvent('tool_end', {
                result: message.content,
                timestamp: getLocalISOString()
              });
            }
          } else if (message.type === "result") {
            result = message.result;

            if (!statusManager) {
              if (useCleanOutput) {
                // Clean completion output - just duration and cost
                console.log(chalk.magenta(`\n    🏁 COMPLETED:`));
                const cost = message.total_cost_usd || 0;
                console.log(chalk.gray(`    ⏱️  Duration: ${(message.duration_ms/1000).toFixed(1)}s, Cost: $${cost.toFixed(4)}`));

                if (message.subtype === "error_max_turns") {
                  console.log(chalk.red(`    ⚠️  Stopped: Hit maximum turns limit`));
                } else if (message.subtype === "error_during_execution") {
                  console.log(chalk.red(`    ❌ Stopped: Execution error`));
                  apiErrorDetected = true;
                }

                if (message.permission_denials && message.permission_denials.length > 0) {
                  console.log(chalk.yellow(`    🚫 ${message.permission_denials.length} permission denials`));
                }
              } else {
                // Full completion output for agents without clean output
                console.log(chalk.magenta(`\n    🏁 COMPLETED:`));
                const cost = message.total_cost_usd || 0;
                console.log(chalk.gray(`    ⏱️  Duration: ${(message.duration_ms/1000).toFixed(1)}s, Cost: $${cost.toFixed(4)}`));

                if (message.subtype === "error_max_turns") {
                  console.log(chalk.red(`    ⚠️  Stopped: Hit maximum turns limit`));
                } else if (message.subtype === "error_during_execution") {
                  console.log(chalk.red(`    ❌ Stopped: Execution error`));
                  apiErrorDetected = true;
                }

                if (message.permission_denials && message.permission_denials.length > 0) {
                  console.log(chalk.yellow(`    🚫 ${message.permission_denials.length} permission denials`));
                }

                // Show result content (if it's reasonable length)
                if (result && typeof result === 'string') {
                  if (result.length > 1000) {
                    console.log(chalk.magenta(`    📄 ${result.slice(0, 1000)}... [${result.length} total chars]`));
                  } else {
                    console.log(chalk.magenta(`    📄 ${result}`));
                  }
                }
              }
            }

            // Track cost for all agents
            const cost = message.total_cost_usd || 0;
            const agentKey = description.toLowerCase().replace(/\s+/g, '-');
            costResults.agents[agentKey] = cost;
            costResults.total += cost;

            // Store cost for return value and partial tracking
            totalCost = cost;
            partialCost = cost;
            break;
          } else {
            // Log any other message types we might not be handling
            console.log(chalk.gray(`    💬 ${message.type}: ${JSON.stringify(message, null, 2)}`));
          }
        }
      });
    } catch (queryError) {
      throw queryError; // Re-throw to outer catch
    }

    const duration = timer.stop();
    const agentKey = description.toLowerCase().replace(/\s+/g, '-');
    timingResults.agents[agentKey] = duration;

    // API error detection is logged but not immediately failed
    // Let the retry logic handle validation first
    if (apiErrorDetected) {
      console.log(chalk.yellow(`  ⚠️ API Error detected in ${description} - will validate deliverables before failing`));
    }

    // Finish status line for parallel execution
    if (statusManager) {
      statusManager.clearAgentStatus(description);
      statusManager.finishStatusLine();
    }

    // NOTE: Log writing now handled by AuditSession (crash-safe, append-only)
    // Legacy log writing removed - audit system handles this automatically

    // Show completion messages based on agent type
    if (progressIndicator) {
      // Single agents with progress indicator
      const agentType = description.includes('Pre-recon') ? 'Pre-recon analysis' :
                       description.includes('Recon') ? 'Reconnaissance' :
                       description.includes('Report') ? 'Report generation' : 'Analysis';
      progressIndicator.finish(`${agentType} complete! (${turnCount} turns, ${formatDuration(duration)})`);
    } else if (isParallelExecution) {
      // Compact completion for parallel agents
      const prefix = getAgentPrefix(description);
      console.log(chalk.green(`${prefix} ✅ Complete (${turnCount} turns, ${formatDuration(duration)})`));
    } else if (!useCleanOutput) {
      // Verbose completion for remaining agents
      console.log(chalk.green(`  ✅ DokodemoDoor Code completed: ${description} (${turnCount} turns) in ${formatDuration(duration)}`));
    }

    // Return result with log file path for all agents
    const returnData = {
      result,
      success: true,
      duration,
      turns: turnCount,
      cost: totalCost,
      partialCost, // Include partial cost for crash recovery
      apiErrorDetected
    };
    if (logFilePath) {
      returnData.logFile = logFilePath;
    }

    // Print and save proxy metrics
    if (agentName && sessionMetadata) {
      printProxyMetrics(agentName);
      const logDir = generateSessionLogPath(sessionMetadata.webUrl, sessionMetadata.id);
      await saveProxyMetrics(logDir, agentName);
    }

    return returnData;

  } catch (error) {
    const duration = timer.stop();
    const agentKey = description.toLowerCase().replace(/\s+/g, '-');
    timingResults.agents[agentKey] = duration;

    // Clear status for parallel execution before showing error
    if (statusManager) {
      statusManager.clearAgentStatus(description);
      statusManager.finishStatusLine();
    }

    // Log error to audit system
    if (auditSession) {
      await auditSession.logEvent('error', {
        message: error.message,
        errorType: error.constructor.name,
        stack: error.stack,
        duration,
        turns: turnCount,
        timestamp: getLocalISOString()
      });
    }

    // Show error messages based on agent type
    if (progressIndicator) {
      // Single agents with progress indicator
      progressIndicator.stop();
      const agentType = description.includes('Pre-recon') ? 'Pre-recon analysis' :
                       description.includes('Recon') ? 'Reconnaissance' :
                       description.includes('Report') ? 'Report generation' : 'Analysis';
      console.log(chalk.red(`❌ ${agentType} failed (${formatDuration(duration)})`));
    } else if (isParallelExecution) {
      // Compact error for parallel agents
      const prefix = getAgentPrefix(description);
      console.log(chalk.red(`${prefix} ❌ Failed (${formatDuration(duration)})`));
    } else if (!useCleanOutput) {
      // Verbose error for remaining agents
      console.log(chalk.red(`  ❌ DokodemoDoor Code failed: ${description} (${formatDuration(duration)})`));
    }
    console.log(chalk.red(`    Error Type: ${error.constructor.name}`));
    console.log(chalk.red(`    Message: ${error.message}`));
    console.log(chalk.gray(`    Agent: ${description}`));
    console.log(chalk.gray(`    Working Directory: ${sourceDir}`));
    console.log(chalk.gray(`    Retryable: ${isRetryableError(error) ? 'Yes' : 'No'}`));

    // Log additional context if available
    if (error.code) {
      console.log(chalk.gray(`    Error Code: ${error.code}`));
    }
    if (error.status) {
      console.log(chalk.gray(`    HTTP Status: ${error.status}`));
    }

    // Save detailed error to log file for debugging
    try {
      const errorLog = {
        timestamp: getLocalISOString(),
        agent: description,
        error: {
          name: error.constructor.name,
          message: error.message,
          code: error.code,
          status: error.status,
          stack: error.stack
        },
        context: {
          sourceDir,
          prompt: fullPrompt.slice(0, 200) + '...',
          retryable: isRetryableError(error)
        },
        duration
      };

      const logPath = path.join(sourceDir, 'error.log');
      await fs.appendFile(logPath, JSON.stringify(errorLog) + '\n');
    } catch (logError) {
      // Ignore logging errors to avoid cascading failures
      console.log(chalk.gray(`    (Failed to write error log: ${logError.message})`));
    }

    return {
      error: error.message,
      errorType: error.constructor.name,
      prompt: fullPrompt.slice(0, 100) + '...',
      success: false,
      duration,
      cost: partialCost, // Include partial cost on error
      retryable: isRetryableError(error)
    };
  }
}

// PREFERRED: Production-ready agent execution with full orchestration
// This is the standard function for all agent execution. Provides:
// - Intelligent retry logic with exponential backoff
// - Output validation to ensure deliverables are created
// - Prompt snapshotting for debugging and reproducibility
// - Git checkpoint/rollback safety for workspace protection
// - Comprehensive error handling and logging
// - Crash-safe audit logging via AuditSession
/**
 * [목적] 재시도/검증/체크포인트 포함한 표준 에이전트 실행.
 *
 * [호출자]
 * - checkpoint-manager.js와 dokodemodoor.mjs 오케스트레이션 경로
 *
 * [출력 대상]
 * - 실행 결과 객체 반환 및 감사 로그 기록
 *
 * [입력 파라미터]
 * - prompt (string)
 * - sourceDir (string)
 * - allowedTools (string)
 * - context (string)
 * - description (string)
 * - agentName (string|null)
 * - colorFn (function)
 * - sessionMetadata (object|null)
 *
 * [반환값]
 * - Promise<object>
 *
 * [부작용]
 * - Git 체크포인트/롤백, audit log 기록, deliverables 생성
 */
export async function runAgentPromptWithRetry(prompt, sourceDir, allowedTools = 'Read', context = '', description = 'Agent analysis', agentName = null, colorFn = chalk.cyan, sessionMetadata = null) {
  const maxRetries = 3;
  let lastError;
  let retryContext = context; // Preserve context between retries

  console.log(chalk.cyan(`🚀 Starting ${description} with ${maxRetries} max attempts`));

  // Initialize audit session (crash-safe logging)
  let auditSession = null;
  if (sessionMetadata && agentName) {
    auditSession = new AuditSession(sessionMetadata);
    await auditSession.initialize();
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Create checkpoint before each attempt
    await createGitCheckpoint(sourceDir, description, attempt);

    // Start agent tracking in audit system (saves prompt snapshot automatically)
    if (auditSession) {
      const fullPrompt = retryContext ? `${retryContext}\n\n${prompt}` : prompt;
      await auditSession.startAgent(agentName, fullPrompt, attempt);

      // Print debug log path if enabled
      if (envConfig.dokodemodoor.agentDebugLog) {
        const debugLogPath = auditSession.getDebugLogPath();
        if (debugLogPath) {
          console.log(chalk.gray(`    📝 Agent Dialogue Log: ${debugLogPath}`));
        }
      }
    }

    try {
      const result = await runAgentPrompt(prompt, sourceDir, allowedTools, retryContext, description, agentName, colorFn, sessionMetadata, auditSession, attempt);

      // Validate output after successful run
      if (result.success) {
        const validationPassed = await validateAgentOutput(result, agentName, sourceDir, auditSession);

        if (validationPassed) {
          // Check if API error was detected but validation passed
          if (result.apiErrorDetected) {
            console.log(chalk.yellow(`📋 Validation: Ready for exploitation despite API error warnings`));
          }

          // Commit successful changes (will include the snapshot)
          const commitInfo = await commitGitSuccess(sourceDir, description);
          const commitHash = commitInfo.commitHash || await getGitHeadHash(sourceDir);

          // Record successful attempt in audit system
          if (auditSession) {
            await auditSession.endAgent(agentName, {
              attemptNumber: attempt,
              duration_ms: result.duration,
              cost_usd: result.cost || 0,
              success: true,
              checkpoint: commitHash
            });
          }

          // [SCREENSHOT ENHANCEMENT] Capture screenshot on exploit success
          if (agentName && agentName.includes('exploit')) {
            try {
              const promptName = agentNameToPromptName(agentName);
              const playwrightMcpName = MCP_AGENT_MAPPING[promptName];

              if (playwrightMcpName) {
                console.log(chalk.blue(`    📸 Exploit success! Capturing verification screenshot...`));
                await captureExploitScreenshot(agentName, sourceDir, playwrightMcpName);
              }
            } catch (screenshotError) {
              console.log(chalk.yellow(`    ⚠️  Failed to capture exploit screenshot: ${screenshotError.message}`));
            }
          }

          console.log(chalk.green.bold(`🎉 ${description} completed successfully on attempt ${attempt}/${maxRetries}`));
          result.checkpoint = commitHash;
          return result;
        } else {
          // Agent completed but output validation failed
          console.log(chalk.yellow(`⚠️ ${description} completed but output validation failed`));

          // Record failed validation attempt in audit system
          if (auditSession) {
            await auditSession.endAgent(agentName, {
              attemptNumber: attempt,
              duration_ms: result.duration,
              cost_usd: result.partialCost || result.cost || 0,
              success: false,
              error: 'Output validation failed',
              isFinalAttempt: attempt === maxRetries
            });
          }

          // If API error detected AND validation failed, this is a retryable error
          if (result.apiErrorDetected) {
            console.log(chalk.yellow(`⚠️ API Error detected with validation failure - treating as retryable`));
            lastError = new Error('API Error: terminated with validation failure');
          } else {
            lastError = new Error('Output validation failed');
          }

          if (attempt < maxRetries) {
            // Rollback contaminated workspace
            await rollbackGitWorkspace(sourceDir, 'validation failure');
            continue;
          } else {
            // FAIL FAST - Don't continue with broken pipeline
            throw new PentestError(
              `Agent ${description} failed output validation after ${maxRetries} attempts. Required deliverable files were not created.`,
              'validation',
              false,
              { description, sourceDir, attemptsExhausted: maxRetries }
            );
          }
        }
      }

    } catch (error) {
      lastError = error;

      // Record failed attempt in audit system
      if (auditSession) {
        await auditSession.endAgent(agentName, {
          attemptNumber: attempt,
          duration_ms: error.duration || 0,
          cost_usd: error.cost || 0,
          success: false,
          error: error.message,
          isFinalAttempt: attempt === maxRetries
        });
      }

      // Check if error is retryable
      if (!isRetryableError(error)) {
        console.log(chalk.red(`❌ ${description} failed with non-retryable error: ${error.message}`));
        await rollbackGitWorkspace(sourceDir, 'non-retryable error cleanup');
        throw error;
      }

      if (attempt < maxRetries) {
        // Rollback for clean retry
        await rollbackGitWorkspace(sourceDir, 'retryable error cleanup');

        const delay = getRetryDelay(error, attempt);
        const delaySeconds = (delay / 1000).toFixed(1);
        const errorMsg = error?.message || String(error) || 'Unknown error';
        console.log(chalk.yellow(`⚠️ ${description} failed (attempt ${attempt}/${maxRetries})`));
        console.log(chalk.gray(`    Error: ${errorMsg}`));
        console.log(chalk.gray(`    Workspace rolled back, retrying in ${delaySeconds}s...`));

        // Preserve any partial results for next retry
        if (error.partialResults) {
          retryContext = `${context}\n\nPrevious partial results: ${JSON.stringify(error.partialResults)}`;
        }

        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        const finalErrorMsg = error?.message || String(error) || 'Unknown error';
        await rollbackGitWorkspace(sourceDir, 'final failure cleanup');
        console.log(chalk.red(`❌ ${description} failed after ${maxRetries} attempts`));
        console.log(chalk.red(`    Final error: ${finalErrorMsg}`));
      }
    }
  }

  throw lastError;
}

// Helper function to get git commit hash (prefer git-manager helper)
async function getGitCommitHash(sourceDir) {
  return await getGitHeadHash(sourceDir);
}

/**
 * [목적] 익스플로잇 성공 시 현재 브라우저 화면을 스크린샷으로 저장.
 */
async function captureExploitScreenshot(agentName, sourceDir, playwrightMcpName) {
  try {
    const { mcpManager } = await import('./tools/mcp-proxy.js');
    const proxy = mcpManager.proxies.get(playwrightMcpName);

    if (!proxy) {
      console.log(chalk.yellow(`    ⚠️  MCP Proxy ${playwrightMcpName} not found, skipping screenshot.`));
      return;
    }

    const screenshotDir = path.join(sourceDir, 'deliverables', 'screenshots');
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = path.join(screenshotDir, `${agentName}-${timestamp}.png`);

    console.log(chalk.gray(`    📸 Saving screenshot to: ${screenshotPath}`));

    // Call browser_screenshot tool via MCP
    const response = await proxy.callTool('browser_screenshot', {});

    if (response && response.content && response.content[0] && response.content[0].data) {
      const base64Data = response.content[0].data;
      fs.writeFileSync(screenshotPath, Buffer.from(base64Data, 'base64'));
      console.log(chalk.green(`    ✅ Screenshot saved: ${path.basename(screenshotPath)}`));
    } else {
       // Fallback: try to see if it returned a simple base64 string or error
       const result = response.content?.[0]?.text || JSON.stringify(response);
       if (result.startsWith('Error')) {
         console.log(chalk.yellow(`    ⚠️  MCP reported error: ${result}`));
       } else {
         console.log(chalk.yellow(`    ⚠️  Unexpected screenshot response format. Content blocks: ${response.content?.length || 0}`));
       }
    }
  } catch (err) {
    console.log(chalk.yellow(`    ⚠️  Screenshot capture failed: ${err.message}`));
  }
}
