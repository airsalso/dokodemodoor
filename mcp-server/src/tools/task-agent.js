/**
* 태스크 에이전트 도구
* 메인 에이전트가 특수 서브 에이전트에 작업을 위임할 수 있도록 합니다.
* 이 기능은 vLLM용 Claude SDK의 태스크 에이전트 기능을 복제합니다.
*
* 서브 에이전트는 다음 작업에 접근할 수 있습니다.
* - 파일 읽기/쓰기 작업
* - 코드 검색 및 분석
* - Bash 명령 실행
* - 모든 표준 파일 시스템 작업
*/

import { z } from 'zod';
import { getProvider } from '../../../src/ai/llm-provider.js';
import { toolRegistry } from '../../../src/ai/tools/tool-registry.js';
import { config } from '../../../src/config/env.js';
import { getAgentName, getTargetDir, getWebUrl } from '../../../src/utils/context.js';
import chalk from 'chalk';

export const TaskAgentInputSchema = z.object({
  task: z.string().describe('Name/description of the specialized agent to create'),
  input: z.string().describe('The specific task or question to ask the specialized agent')
});

/**
 * Bash tool for sub-agents
 * Allows executing shell commands in the target directory
 */
export const BashToolSchema = z.object({
  command: z.string().describe('The bash command to execute')
});

/**
 * [목적] 서브 에이전트용 bash 명령 실행.
 *
 * [호출자]
 * - registerSubAgentTools()로 등록된 bash/Bash/alias 도구
 *
 * [출력 대상]
 * - 표준화된 실행 결과 객체 반환
 *
 * [입력 파라미터]
 * - params.command (string)
 *
 * [반환값]
 * - Promise<object>
 */
export async function executeBash(params) {
  let { command } = params;
  const targetDir = getTargetDir();
  const agentName = (getAgentName() || '').toLowerCase();
  const webUrl = getWebUrl();
  let safeCommand = command;

  try {
    // Normalize miswrapped JSON command payloads
    const trimmed = (safeCommand || '').trim();
    if (trimmed.startsWith('{') && trimmed.includes('"command"')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.command === 'string') {
          safeCommand = parsed.command;
        }
      } catch (e) {
        // Fall through and let execution fail with a clear error below
      }
    }

    if (!safeCommand || typeof safeCommand !== 'string') {
      throw new Error('Missing bash command');
    }

    // Enforce target URL usage for api-fuzzer to avoid localhost drift
    if (agentName.includes('api-fuzzer') && webUrl) {
      const host = (() => {
        try {
          return new URL(webUrl).hostname;
        } catch {
          return null;
        }
      })();
      const usesLocalhost = /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(safeCommand);
      const isTargetLocal = host === 'localhost' || host === '127.0.0.1';
      if (usesLocalhost && !isTargetLocal) {
        return {
          status: 'error',
          output: `Blocked: api-fuzzer must use target webUrl (${webUrl}) instead of localhost.`,
          exitCode: 2
        };
      }
    }

    // Add timeout to prevent hanging on large searches
    const timeoutSeconds = 60;

    console.log(chalk.gray(`      🐚 Executing: ${safeCommand}`));

    // Execute command in target directory using exec
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const { stdout, stderr } = await execAsync(safeCommand, {
      cwd: targetDir,
      shell: '/bin/bash',
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer
      timeout: timeoutSeconds * 1000, // Timeout in milliseconds
      env: {
        ...process.env,
        // Ensure curl/wget traffic goes through configured proxy
        HTTP_PROXY: process.env.HTTP_PROXY || '',
        HTTPS_PROXY: process.env.HTTPS_PROXY || '',
        http_proxy: process.env.http_proxy || '',
        https_proxy: process.env.https_proxy || '',
        NO_PROXY: process.env.NO_PROXY || '',
        no_proxy: process.env.no_proxy || ''
      }
    });

    const output = stdout || stderr || '';
    console.log(chalk.gray(`      ✅ Command completed (${output.length} chars)`));

    return {
      status: 'success',
      output: output.trim(),
      exitCode: 0
    };
  } catch (error) {
    // Check if it's a timeout error
    const timeoutMsg = typeof timeoutSeconds !== 'undefined' ? timeoutSeconds : 60;
    if (error.killed && error.signal === 'SIGTERM') {
      console.log(chalk.red(`      ❌ Command timed out after ${timeoutMsg}s`));
      return {
        status: 'error',
        output: `Command timed out after ${timeoutMsg} seconds. Try a more specific search pattern or check for heavy commands.`,
        exitCode: 124 // Standard timeout exit code
      };
    }

    const output = error.stdout || error.stderr || error.message;

    // Special handling for grep: exit code 1 means "no matches found", which is a valid result
    if (safeCommand.trim().startsWith('grep') && error.code === 1) {
      return {
        status: 'success',
        output: '(No matches found)',
        exitCode: 1
      };
    }

    return {
      status: 'error',
      output: output,
      exitCode: error.code || 1
    };
  }
}

/**
 * TodoWrite tool for sub-agents to maintain their task list
 */
export const TodoWriteSchema = z.object({
  todo: z.string().describe('The updated todo list content or specific items to add')
});

/**
 * [목적] 서브 에이전트의 todo 상태 업데이트.
 *
 * [호출자]
 * - registerSubAgentTools()의 TodoWrite 도구
 *
 * [출력 대상]
 * - 성공 메시지 반환
 *
 * [입력 파라미터]
 * - params.todo (string)
 *
 * [반환값]
 * - Promise<object>
 */
export async function executeTodoWrite(params) {
  const { todo } = params;
  console.log(chalk.gray(`      📝 Todo Updated: ${todo.substring(0, 50)}${todo.length > 50 ? '...' : ''}`));
  return {
    status: 'success',
    message: 'Todo list updated successfully'
  };
}

/**
 * Register sub-agent specific tools
 * These tools are only available to sub-agents created by TaskAgent
 */
/**
 * [목적] 서브 에이전트 전용 도구 레지스트리 구성.
 *
 * [호출자]
 * - taskAgent()
 *
 * [출력 대상]
 * - 서브 에이전트용 ToolRegistry 반환
 *
 * [반환값]
 * - ToolRegistry
 *
 * [주의사항]
 * - save_deliverable은 의도적으로 제외
 */
function registerSubAgentTools() {
  const subAgentRegistry = new (toolRegistry.constructor)();

  // Register bash tool
  subAgentRegistry.register(
    'bash',
    'Execute bash commands for file operations, code search (grep, find), and analysis.',
    BashToolSchema,
    executeBash
  );

  // Register Bash (capitalized) as alias
  subAgentRegistry.register(
    'Bash',
    'Alias for bash tool',
    BashToolSchema,
    executeBash
  );

  // Register TodoWrite tool
  subAgentRegistry.register(
    'TodoWrite',
    'Write or update your internal todo list to track progress.',
    TodoWriteSchema,
    executeTodoWrite
  );

  // Common aliases that LLMs might use based on their training
  const bashAliases = ['grep', 'search_file', 'open_file', 'read_file', 'ls', 'find', 'list_files', 'rg'];
  for (const alias of bashAliases) {
    subAgentRegistry.register(
      alias,
      `Alias for bash. Use this for ${alias} operations.`,
      z.object({
        command: z.string().optional(),
        path: z.string().optional(),
        query: z.string().optional(),
        line_start: z.coerce.number().optional(),
        line_end: z.coerce.number().optional(),
        max_results: z.coerce.number().optional()
      }),
      async (p) => {
        let cmd = p.command;

        // Cache rg availability for faster searches when possible
        if (typeof global.__DOKODEMODOOR_RG_AVAILABLE === 'undefined') {
          try {
            const { execSync } = await import('child_process');
            execSync('command -v rg', { stdio: 'ignore' });
            global.__DOKODEMODOOR_RG_AVAILABLE = true;
          } catch (e) {
            global.__DOKODEMODOOR_RG_AVAILABLE = false;
          }
        }

        // Helper to quote strings for shell
        const shQuote = (str) => {
          if (!str) return '""';
          return "'" + str.replace(/'/g, "'\\''") + "'";
        };

        // Path normalization: Safe guarding against LLM omitting leading slash on absolute paths.
        if (p.path) {
          const targetDir = getTargetDir();
          const fs = await import('node:fs');
          const pathMod = await import('node:path');

          // Resolve relative paths against repo root
          if (!pathMod.isAbsolute(p.path)) {
            const absCandidate = pathMod.resolve(targetDir, p.path);
            if (fs.existsSync(absCandidate)) {
              p.path = absCandidate;
              console.log(chalk.gray(`      🔧 Auto-resolved path: ${p.path}`));
            }
          }

          // If still missing, attempt basename recovery via rg --files
          if (!fs.existsSync(p.path)) {
            try {
              const { execSync } = await import('child_process');
              const base = pathMod.basename(p.path);
              const cmd = `rg --files -g '*${base}*' ${shQuote(targetDir)} | head -n 1`;
              const match = execSync(cmd, { encoding: 'utf8' }).trim();
              if (match) {
                p.path = match;
                console.log(chalk.gray(`      🔧 Auto-recovered path: ${p.path}`));
              }
            } catch (e) {
              // Best-effort fallback; keep original path if anything fails.
            }
          }

          // Legacy normalization for absolute-like paths missing leading slash
          if (!p.path.startsWith('/')) {
            const correctedPath = '/' + p.path;
            if (!fs.existsSync(p.path) && correctedPath.includes(targetDir)) {
              p.path = correctedPath;
              console.log(chalk.gray(`      🔧 Context-aware path normalization: ${p.path}`));
            }
          }
        }

        // Logical mapping based on alias and provided parameters
        if (alias === 'open_file' || alias === 'read_file') {
          if (!cmd && p.path) {
            if (p.line_start !== undefined || p.line_end !== undefined) {
              const start = p.line_start || 1;
              const end = p.line_end || '$';

              cmd = `sed -n '${start},${end}p' ${shQuote(p.path)}`;
            } else {
              cmd = `cat ${shQuote(p.path)}`;
            }
          }
        } else if (alias === 'grep' || alias === 'search_file') {
          if (p.query) {
            const max = p.max_results || 100;
            const targetPath = p.path || '.';
            if (global.__DOKODEMODOOR_RG_AVAILABLE) {
              cmd = `rg -n --no-heading --color never ${shQuote(p.query)} ${shQuote(targetPath)} | head -n ${max}`;
            } else {
              // -n for line numbers, -r for recursive
              cmd = `grep -rn -- ${shQuote(p.query)} ${shQuote(targetPath)} | head -n ${max}`;
            }
          }
        } else if (alias === 'ls') {
          const targetPath = p.path || '.';
          cmd = `ls -la ${shQuote(targetPath)}`;
        } else if (alias === 'find' && p.query) {
          const targetPath = p.path || '.';
          cmd = `find ${shQuote(targetPath)} -name ${shQuote(`*${p.query}*`)}`;
        } else if (alias === 'list_files' && p.query) {
          const targetPath = p.path || '.';
          if (global.__DOKODEMODOOR_RG_AVAILABLE) {
            cmd = `rg --files -g ${shQuote(`*${p.query}*`)} ${shQuote(targetPath)}`;
          } else {
            cmd = `find ${shQuote(targetPath)} -name ${shQuote(`*${p.query}*`)}`;
          }
        }

        // Fallback to p.command if still empty
        if (!cmd) {
          cmd = p.command || (p.path ? `cat ${shQuote(p.path)}` : null) || (p.query ? `grep -rn -- ${shQuote(p.query)} ${shQuote(p.path || '.')} | head -n 100` : null);
        }

        // AUTO-FIX: If we have a path but the command (like sed, cat, head, tail) doesn't contain it, append it.
        // DO NOT auto-fix if command contains a pipe, as appending at the end is usually wrong for piped commands.
        if (p.path && cmd && !cmd.includes('|')) {
          const commonTools = ['cat', 'sed', 'head', 'tail', 'grep', 'wc', 'strings'];
          const firstWord = cmd.trim().split(/\s+/)[0];

          if (commonTools.includes(firstWord)) {
            const escapedPath = p.path.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
            // Support matching path even if it is quoted
            const pathRegex = new RegExp(`(^|\\s)[\\"']?${escapedPath}[\\"']?(\\s|$)`);

            if (!pathRegex.test(cmd)) {
              cmd = `${cmd.trim()} ${p.path}`;
              console.log(chalk.gray(`      🔧 Auto-fixed command: ${cmd}`));
            }
          }
        }

        if (!cmd) return { status: 'error', message: 'Missing command or path' };
        return executeBash({ command: cmd });
      }
    );
  }

// CRITICAL: Sub-agents should NEVER save deliverables as it causes premature phase termination
  // We removed save_deliverable from sub-agent tools to avoid confusing the LLM and generating blocked messages.
  // Instead, sub-agents are instructed to return findings via ## Summary.

  return subAgentRegistry;
}

/**
 * Execute a task using a specialized sub-agent
 *
 * @param {Object} params - Task parameters
 * @param {string} params.task - Agent name/description
 * @param {string} params.input - Task input
 * @returns {Promise<Object>} Task result
 */
/**
 * [목적] 서브 에이전트 실행 및 결과 수집.
 *
 * [호출자]
 * - MCP 도구 호출 (TaskAgent)
 *
 * [출력 대상]
 * - 서브 에이전트 결과 요약 반환
 *
 * [입력 파라미터]
 * - params.task (string)
 * - params.input (string)
 *
 * [반환값]
 * - Promise<object>
 *
 * [부작용]
 * - LLM 호출, bash 도구 실행, 콘솔 로그 출력
 */
export async function taskAgent(params) {
  const { task, input } = params;

  try {
    console.log(chalk.blue(`    🎯 Creating sub-agent: ${task}`));
    console.log(chalk.gray(`    Task: ${input.substring(0, 100)}${input.length > 100 ? '...' : ''}`));

    // Get the target directory and parent agent name from context
    const targetDir = getTargetDir();
    const parentAgentName = getAgentName();
    const subAgentName = `sub-agent-${parentAgentName.replace('sub-agent-', '')}`;

    // Create sub-agent tool registry
    const subAgentRegistry = registerSubAgentTools();

    // Execute sub-agent query with limited turns
    const maxTurns = config.dokodemodoor.subAgentMaxTurns;
    if (!maxTurns) {
      console.error(chalk.red(`    ⚠️  config.dokodemodoor.subAgentMaxTurns is not set! Using fallback: 20`));
    }
    console.log(chalk.gray(`    🔧 TaskAgent config: maxTurns=${maxTurns || 20}`));

    const queryOptions = {
      cwd: targetDir,
      maxTurns: maxTurns || 20, // Fallback to 20 if config fails to load
      registry: subAgentRegistry,
      agentName: subAgentName,
      enableEmergencySave: false // Disable emergency save for sub-agents
    };

    // Create a focused prompt for the sub-agent with tool usage instructions
    const subAgentPrompt = `You are a specialized ${task}.

Your task: ${input}

Working directory: [Project Root]
IMPORTANT: You are already in the project root. All commands execute in this directory. All paths should be relative to this root.

**PROHIBITED ACTIONS:**
- DO NOT attempt to install any packages, libraries, or dependencies (e.g., NO 'npm install', 'pip install', 'apt-get').
- DO NOT attempt to start servers or long-running processes.
- DO NOT attempt to download large files.
- Use ONLY the pre-installed tools and bash commands for analysis.

AVAILABLE TOOLS:
- bash: Execute shell commands to explore files, search code, analyze structure
  Examples:
  * List files (clean): bash({"command": "ls -F"})
  * Fast filename search: list_files({"query": "router", "path": "."})
  * Find files (efficient): bash({"command": "find . -maxdepth 3 -not -path '*/.*'"})
  * Search code (excluding noise): bash({"command": "grep -r 'auth' . --exclude-dir={node_modules,dist,frontend,.git}"})
  * Read file: bash({"command": "cat server.js"})

- TodoWrite: Maintain your own internal todo list and task progress
  Example: TodoWrite({"todo": "1. Analyze server.js\\n2. Map auth routes\\n3. [DONE] Initial scan"})

CRITICAL RULES:
- YOU HAVE ${queryOptions.maxTurns} TURNS PER SESSION.
- You can request MULTIPLE SESSIONS if needed to complete your investigation.
- **NEVER attempt to call save_deliverable.** It is NOT available to you.
- **ALWAYS return your findings via "## Summary"** at the end of your investigation.
- **ONLY the main agent can save deliverables.** Your role is to provide the analysis for it.
- ALWAYS use current directory (.) for searches - you are already in the target directory
- BE EFFICIENT: Use grep/find to map the codebase first. Do NOT read files one by one if they can be searched.
- Use --exclude-dir with grep or -prune with find instead of long "grep -v" chains.
- Use the bash tool extensively to explore and analyze the codebase
- Provide direct, technical analysis based on actual source code findings
- Include specific file paths and code snippets in your analysis
- Focus on security-relevant findings and concrete examples
- Do NOT provide code templates or generic advice
- Do NOT ask for clarification - analyze what you find
- Execute multiple bash commands to gather comprehensive information

**AUTONOMOUS ITERATION:**
You are an AUTONOMOUS agent. You decide when your investigation is complete.

**CRITICAL TURN MANAGEMENT:**
You have ${queryOptions.maxTurns} turns per session. Plan your time wisely:

**Recommended Timeline:**
- Turns 1-${Math.floor(queryOptions.maxTurns * 0.7)}: Investigation and data collection
- Turns ${Math.floor(queryOptions.maxTurns * 0.7) + 1}-${Math.floor(queryOptions.maxTurns * 0.85)}: Organize findings, decide if complete
- Turns ${Math.floor(queryOptions.maxTurns * 0.85) + 1}-${queryOptions.maxTurns}: Write "## Summary" OR "CONTINUE:"

**Around turn ${Math.floor(queryOptions.maxTurns * 0.7)}:** Start organizing your findings
**Around turn ${Math.floor(queryOptions.maxTurns * 0.85)}:** Begin writing your summary or CONTINUE message
**DO NOT wait until the last turn!** Reserve 2-3 turns for writing your summary.

**If you need to continue investigating** (e.g., found 100 files but only analyzed 7):
- End your response with: "CONTINUE: [brief reason]"
- Example: "CONTINUE: Found 93 more route files to analyze"
- You will be called again with a new ${queryOptions.maxTurns}-turn session
- Your previous findings will be provided as context

**If your investigation is complete**:
- End your response with: "## Summary"
- Provide a comprehensive summary of ALL findings across all sessions
- This signals completion to the main agent

**OUTPUT REQUIREMENTS:**
- Keep each session output under 150 lines - be concise and actionable
- Prioritize KEY findings over exhaustive lists
- If you hit your turn limit mid-investigation, use "CONTINUE: [reason]"
- Structure your output in clear sections (e.g., ## Session N Findings, ## Key Files)
- ONLY use "## Summary" when you have completed the ENTIRE investigation

**EXAMPLE: Good Turn Management**
Turn 1-14: Investigation
Turn 15: "I've analyzed 50 files. Need to check 50 more. CONTINUE: 50 files remaining"
→ New session starts
Turn 1-14: Continue investigation
Turn 15-17: Write comprehensive "## Summary" with ALL findings from both sessions

**EXAMPLE: Bad Turn Management**
Turn 1-19: Investigation
Turn 20: Try to write summary but run out of space ❌
→ Auto-synthesis kicks in (not ideal)


**EXAMPLE WORKFLOW:**
Session 1 (${queryOptions.maxTurns} turns): Analyze first batch of files → "CONTINUE: More files to analyze"
Session 2 (${queryOptions.maxTurns} turns): Continue analysis → "CONTINUE: Still more files remaining"
...
Session N (${queryOptions.maxTurns} turns): Analyzed all targets → "## Summary\\n[Complete findings]"

Start by exploring the directory structure and planning your investigation strategy!`;

    // Get the LLM provider
    const provider = await getProvider();

    try {
      let result = '';
      let turnCount = 0;
      let intermediateFindings = [];
      let lastToolResult = '';

      // Collect sub-agent responses
      let lastAssistantMessage = '';
      for await (const message of provider.query(subAgentPrompt, queryOptions)) {
        if (message.type === 'assistant') {
          turnCount++;
          const content = Array.isArray(message.message.content)
            ? message.message.content.map(c => c.text || JSON.stringify(c)).join('\n')
            : message.message.content;

          if (content) {
            // Store ONLY the most recent assistant message as the candidate result
            // This prevents accumulating the entire thought history in the TaskAgent tool result
            lastAssistantMessage = content;
          }
        } else if (message.type === 'tool_result') {
          // Track tool results for fallback if no summary is provided
          lastToolResult = message.content;
          if (typeof lastToolResult === 'string' && lastToolResult.length > 10) {
             const summary = lastToolResult.length > 500 ? lastToolResult.substring(0, 500) + '...' : lastToolResult;
             intermediateFindings.push(summary);
          }
        } else if (message.type === 'result') {
          // Sub-agent completed - taking the final result
          if (message.result) {
            result = message.result;
          } else {
            // Fallback to the last assistant message if message.result is empty
            result = lastAssistantMessage;
          }
          break;
        }
      }

      // If we finished the loop without a 'result' message (e.g. hit turn limit),
      // default to the last thing the assistant said.
      if (!result.trim()) {
        result = lastAssistantMessage;
      }

      // If the result is still empty or looks like raw tool output (starts with {),
      // attempt a final summarization turn to consolidate intermediate findings
      if (!result.trim() || (result.trim().startsWith('{') && result.trim().endsWith('}'))) {
        if (intermediateFindings.length > 0) {
          console.log(chalk.yellow(`    ⚠️  Sub-agent provided no summary. Synthesizing from tool logs...`));

          const synthesisPrompt = `You are a supervisor consolidating the work of a specialized agent.
The agent was performing: ${input}
The agent hit a limit before summarizing. Here are the tool outputs from the agent's work:

${intermediateFindings.slice(-10).join('\n\n')}

Provide a concise "## Summary" of these findings for the primary agent. Focus on security-relevant technical details.
DO NOT call any tools during this consolidation phase.`;

          try {
            const synthesisOptions = {
              cwd: targetDir,
              maxTurns: 2,
              registry: subAgentRegistry, // Block save_deliverable during synthesis too
              agentName: subAgentName
            };
            for await (const msg of provider.query(synthesisPrompt, synthesisOptions)) {
              if (msg.type === 'assistant' && msg.message.content) {
                result = msg.message.content;
              } else if (msg.type === 'result' && msg.result) {
                // If it's a successful result, it's likely better/more complete than intermediate assistant messages
                result = msg.result;
              }
            }
          } catch (e) {
            console.log(chalk.red(`    ❌ Synthesis failed: ${e.message}`));
          }
        }
      }

      // Final fallback if everything failed
      if (!result.trim()) {
        result = "Sub-agent explored the codebase but hit a limit before providing a final summary. \n" +
                 "Last tool output: \n" + (lastToolResult || "None");
      }

      if (result) {
        // Final sanitation of result:
        // 1. Remove extreme line repetitions
        // 2. Clear out problematic control characters that might break JSON parsing later
        const lines = result.split('\n');
        const sanitizedLines = [];
        let lastLine = null;
        let repeatCount = 0;

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine && trimmedLine === lastLine) {
            repeatCount++;
            if (repeatCount < 5) {
              sanitizedLines.push(line);
            } else if (repeatCount === 5) {
              sanitizedLines.push('...[EXTREME REPETITION DETECTED AND REMOVED for context safety]...');
            }
          } else {
            // Strip bad control characters (keep \n, \r, \t)
            const sanitized = line.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
            sanitizedLines.push(sanitized);
            lastLine = trimmedLine || null;
            repeatCount = 0;
          }
        }
        result = sanitizedLines.join('\n');
      }

      // Limit result size to prevent parent agent context overflow
      const maxResultLength = config.dokodemodoor.subAgentTruncateLimit || 50000;
      let finalResult = result.trim();
      let truncated = false;

      if (finalResult.length > maxResultLength) {
        console.log(chalk.yellow(`    ⚠️  Sub-agent output too large (${finalResult.length} chars). Summarizing to fit limit...`));

        const summaryPrompt = `You are a technical editor. Summarize the following security analysis report to be under ${maxResultLength} characters.
        CRITICAL: Preserve all specific file paths, code snippets, and technical evidence of vulnerabilities.
        Focus on technical facts over descriptive filler.

        REPORT TO SUMMARIZE:
        ${finalResult}`;

        try {
          const summaryOptions = {
            cwd: targetDir,
            maxTurns: 2,
            agentName: `${subAgentName}-summarizer`,
            registry: subAgentRegistry
          };

          let summarized = '';
          for await (const msg of provider.query(summaryPrompt, summaryOptions)) {
            if (msg.type === 'assistant') {
              summarized = Array.isArray(msg.message.content)
                ? msg.message.content.map(c => c.text || JSON.stringify(c)).join('\n')
                : msg.message.content;
            } else if (msg.type === 'result' && msg.result) {
              summarized = msg.result;
            }
          }

          if (summarized && summarized.trim().length > 100) {
            finalResult = summarized.trim();
            console.log(chalk.green(`    ✨ Summarized report down to ${finalResult.length} chars.`));
          } else {
            console.log(chalk.yellow(`    ⚠️  Summarization returned empty or too short. Falling back to truncation.`));
            finalResult = finalResult.substring(0, maxResultLength) + '\n\n...[Output truncated due to size limits]...';
            truncated = true;
          }
        } catch (e) {
          console.log(chalk.red(`    ❌ Summarization failed: ${e.message}. Falling back to truncation.`));
          finalResult = finalResult.substring(0, maxResultLength) + '\n\n...[Output truncated due to size limits]...';
          truncated = true;
        }
      }

      // Detect completion status (allow variants like ## Final Summary, ## Results Summary, ## Findings, ## Conclusion, etc.)
      const hasCompletionMarker = /##.*(Summary|Findings|Conclusion)/i.test(finalResult);
      const hasContinueRequest = /CONTINUE:\s*(.+)/i.test(finalResult);
      const continueReason = hasContinueRequest ? finalResult.match(/CONTINUE:\s*(.+)/i)[1].trim() : null;

      // Determine status
      let status = 'success';
      let needsContinuation = false;

      if (hasCompletionMarker) {
        status = 'complete';
        console.log(chalk.green(`    ✅ Sub-agent completed investigation (${turnCount} turns, ${finalResult.length} chars)`));
      } else if (hasContinueRequest) {
        status = 'incomplete';
        needsContinuation = true;
        console.log(chalk.yellow(`    ⏭️  Sub-agent requests continuation: ${continueReason}`));
      } else if (turnCount >= queryOptions.maxTurns) {
        status = 'incomplete';
        needsContinuation = true;

        // Auto-append CONTINUE if not present to signal the parent agent
        if (!finalResult.includes('CONTINUE:')) {
          finalResult += `\n\nCONTINUE: Sub-agent hit turn limit (${turnCount}) before providing a final summary. More investigation time is likely needed to finish the task.`;
        }

        console.log(chalk.yellow(`    ⚠️  Sub-agent hit turn limit without completion signal (${turnCount} turns)`));
      } else {
        console.log(chalk.green(`    ✅ Sub-agent completed (${turnCount} turns, ${finalResult.length} chars)`));
      }

      return {
        status,
        result: finalResult || 'Sub-agent completed but provided no output',
        turns: turnCount,
        truncated,
        needsContinuation,
        continueReason,
        isComplete: hasCompletionMarker
      };

    } catch (error) {
      console.log(chalk.red(`    ❌ Sub-agent failed: ${error.message}`));

      return {
        status: 'error',
        message: `Sub-agent execution failed: ${error.message}`,
        errorType: error.constructor.name,
        retryable: false
      };
    }

  } catch (error) {
    console.log(chalk.red(`    ❌ TaskAgent overall exception: ${error.message}`));
    return {
      status: 'error',
      message: `TaskAgent failed: ${error.message}`,
      errorType: error.constructor.name,
      retryable: false
    };
  }
}
