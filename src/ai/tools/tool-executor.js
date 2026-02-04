/**
 * Tool Executor
 *
 * Handles tool execution routing and error handling
 * Provides a unified interface for executing tools regardless of provider
 */

import { toolRegistry } from './tool-registry.js';
import chalk from 'chalk';
import { trackToolCall } from './proxy-metrics.js';

/**
 * [목적] 단일 도구 호출 실행 및 결과 반환.
 *
 * [호출자]
 * - executeToolCalls()
 * - vLLM Provider tool execution 루프
 *
 * [출력 대상]
 * - 도구 실행 결과 반환
 *
 * [입력 파라미터]
 * - rawToolName (string)
 * - args (object)
 * - customRegistry (ToolRegistry|null)
 *
 * [반환값]
 * - Promise<object>
 */
export async function executeTool(rawToolName, args, customRegistry = null) {
  const registry = customRegistry || toolRegistry;
  // Sanitize tool name: handles trailing hallucinations like TodoWrite?… or bash<|im_start|>
  const toolName = (rawToolName || '').toString().split(/[<|\[?!\s…\.]/)[0].trim();

  try {
    console.log(chalk.yellow(`\n    🔧 Executing tool: ${toolName}`));
    if (rawToolName !== toolName) {
      console.log(chalk.gray(`    (Sanitized from: ${rawToolName})`));
    }

    if (args && Object.keys(args).length > 0) {
      console.log(chalk.gray(`    Arguments: ${JSON.stringify(args, null, 2)}`));
    }

    // Track tool call for proxy metrics
    trackToolCall(toolName);

    const result = await registry.executeTool(toolName, args);

    console.log(chalk.green(`    ✅ Tool completed: ${toolName}`));

    return result;
  } catch (error) {
    console.log(chalk.red(`    ❌ Tool failed: ${toolName}`));
    console.log(chalk.red(`    Error: ${error.message}`));

    // Return error in tool result format
    return {
      status: 'error',
      message: error.message,
      errorType: error.constructor.name,
      retryable: false
    };
  }
}

/**
 * [목적] 여러 도구 호출을 순차 실행하여 메시지 포맷으로 반환.
 *
 * [호출자]
 * - vLLM Provider (tool_calls 처리)
 *
 * [출력 대상]
 * - tool 메시지 배열 반환
 *
 * [입력 파라미터]
 * - toolCalls (array)
 * - customRegistry (ToolRegistry|null)
 *
 * [반환값]
 * - Promise<array>
 */
export async function executeToolCalls(toolCalls, customRegistry = null) {
  const results = [];

  for (const toolCall of toolCalls) {
    const result = await executeTool(toolCall.name, toolCall.arguments, customRegistry);
    results.push({
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.name,
      content: JSON.stringify(result)
    });
  }

  return results;
}

/**
 * [목적] 도구 결과를 OpenAI tool 메시지 포맷으로 변환.
 *
 * [호출자]
 * - executeToolCalls()
 *
 * [출력 대상]
 * - tool 메시지 객체 반환
 */
export function formatToolResult(toolCallId, toolName, result) {
  return {
    tool_call_id: toolCallId,
    role: 'tool',
    name: toolName,
    content: typeof result === 'string' ? result : JSON.stringify(result)
  };
}
