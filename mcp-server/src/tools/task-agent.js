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
import path from 'node:path';
import fs from 'node:fs';

// Import tool handlers for sub-agent parity
import { listFiles, ListFilesInputSchema } from './list-files.js';
import { readFile, ReadFileInputSchema } from './read-file.js';
import { searchFiles, SearchFileInputSchema } from './search-tools.js';
import { executeBash, BashInputSchema } from './bash-tools.js';

export const TaskAgentInputSchema = z.object({
  task: z.string().describe('Name/description of the specialized agent to create'),
  input: z.string().describe('The specific task or question to ask the specialized agent')
});





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

  // 1. Core Bash & Shell access (using the same hardened executeBash)
  subAgentRegistry.register('bash', 'Execute shell commands.', BashInputSchema, executeBash);
  subAgentRegistry.register('Bash', 'Alias for bash.', BashInputSchema, executeBash);
  subAgentRegistry.register('run_command', 'Alias for bash.', BashInputSchema, executeBash);

  // 2. High-Performance Filesystem Tools (delegated to same handlers)
  subAgentRegistry.register('list_files', 'List files with filtering.', ListFilesInputSchema, listFiles);
  subAgentRegistry.register('ls', 'Alias for bash (provides details).', BashInputSchema, executeBash);
  subAgentRegistry.register('find', 'Alias for bash.', BashInputSchema, executeBash);

  subAgentRegistry.register('read_file', 'Read file content.', ReadFileInputSchema, readFile);
  subAgentRegistry.register('open_file', 'Alias for read_file.', ReadFileInputSchema, readFile);

  subAgentRegistry.register('search_file', 'Search across files.', SearchFileInputSchema, searchFiles);
  subAgentRegistry.register('grep', 'Alias for search_file.', SearchFileInputSchema, searchFiles);
  subAgentRegistry.register('rg', 'Alias for search_file.', SearchFileInputSchema, searchFiles);

  // 3. Todo Maintenance
  subAgentRegistry.register('TodoWrite', 'Update internal todo list.', TodoWriteSchema, executeTodoWrite);

  return subAgentRegistry;
}

// CRITICAL: Sub-agents should NEVER save deliverables as it causes premature phase termination
// We removed save_deliverable from sub-agent tools to avoid confusing the LLM and generating blocked messages.
// Instead, sub-agents are instructed to return findings via ## Summary.

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

export const taskAgentTool = {
  name: 'TaskAgent',
  description: 'Delegate a task to a specialized sub-agent. Use this to analyze source code, trace authentication mechanisms, or investigate specific security concerns.',
  inputSchema: TaskAgentInputSchema,
  handler: taskAgent
};
