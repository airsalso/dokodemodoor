import chalk from 'chalk';
import { fs, path } from 'zx';
import { getLocalISOString } from './utils/time-utils.js';

// Custom error class for pentest operations
/**
 * [목적] 펜테스트 전용 오류 객체 (타입/재시도/컨텍스트 포함).
 *
 * [호출자]
 * - 전 모듈의 에러 처리 경로
 */
export class PentestError extends Error {
  constructor(message, type, retryable = false, context = {}) {
    super(message);
    this.name = 'PentestError';
    this.type = type; // 'config', 'network', 'tool', 'prompt', 'filesystem', 'validation'
    this.retryable = retryable;
    this.context = context;
    this.timestamp = getLocalISOString();
  }
}

// Centralized error logging function
/**
 * [목적] 에러 로그를 콘솔/파일로 기록.
 *
 * [호출자]
 * - 상위 에러 처리 흐름 (CLI/체크포인트 등)
 *
 * [입력 파라미터]
 * - error (Error)
 * - contextMsg (string)
 * - sourceDir (string|null)
 *
 * [반환값]
 * - Promise<object>
 */
export const logError = async (error, contextMsg, sourceDir = null) => {
  const timestamp = getLocalISOString();
  const logEntry = {
    timestamp,
    context: contextMsg,
    error: {
      name: error.name || error.constructor.name,
      message: error.message,
      type: error.type || 'unknown',
      retryable: error.retryable || false,
      stack: error.stack
    }
  };

  // Console logging with color
  const prefix = error.retryable ? '⚠️' : '❌';
  const color = error.retryable ? chalk.yellow : chalk.red;
  console.log(color(`${prefix} ${contextMsg}:`));
  console.log(color(`   ${error.message}`));

  if (error.context && Object.keys(error.context).length > 0) {
    console.log(chalk.gray(`   Context: ${JSON.stringify(error.context)}`));
  }

  // File logging (if source directory available)
  if (sourceDir) {
    try {
      const logPath = path.join(sourceDir, 'error.log');
      await fs.appendFile(logPath, JSON.stringify(logEntry) + '\n');
    } catch (logErr) {
      console.log(chalk.gray(`   (Failed to write error log: ${logErr.message})`));
    }
  }

  return logEntry;
};

// Handle tool execution errors
/**
 * [목적] 도구 실행 오류를 표준 결과 포맷으로 래핑.
 *
 * [호출자]
 * - tool execution 흐름
 */
export const handleToolError = (toolName, error) => {
  const isRetryable = error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND';

  return {
    tool: toolName,
    output: `Error: ${error.message}`,
    status: 'error',
    duration: 0,
    success: false,
    error: new PentestError(
      `${toolName} execution failed: ${error.message}`,
      'tool',
      isRetryable,
      { toolName, originalError: error.message, errorCode: error.code }
    )
  };
};

// Handle prompt loading errors
/**
 * [목적] 프롬프트 로딩 오류를 PentestError로 래핑.
 *
 * [호출자]
 * - prompt-manager.js
 */
export const handlePromptError = (promptName, error) => {
  return {
    success: false,
    error: new PentestError(
      `Failed to load prompt '${promptName}': ${error.message}`,
      'prompt',
      false,
      { promptName, originalError: error.message }
    )
  };
};


// Check if an error should trigger a retry for agent execution
/**
 * [목적] 에러 메시지를 기반으로 재시도 여부 판단.
 *
 * [호출자]
 * - agent-executor 재시도 로직
 */
export const isRetryableError = (error) => {
  const message = error.message.toLowerCase();

  // Network and connection errors - always retryable
  if (message.includes('network') ||
      message.includes('connection') ||
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('enotfound') ||
      message.includes('econnrefused')) {
    return true;
  }

  // Rate limiting - retryable with longer backoff
  if (message.includes('rate limit') ||
      message.includes('429') ||
      message.includes('too many requests')) {
    return true;
  }

  // Server errors - retryable
  if (message.includes('server error') ||
      message.includes('internal server error') ||
      message.includes('500') ||
      message.includes('502') ||
      message.includes('503') ||
      message.includes('504') ||
      message.includes('5xx') ||
      message.includes('service unavailable') ||
      message.includes('bad gateway') ||
      message.includes('unexpected tokens remaining in message header')) {
    return true;
  }

  // API specific errors - retryable
  if (message.includes('mcp server') ||
      message.includes('model unavailable') ||
      message.includes('service temporarily unavailable') ||
      message.includes('api error') ||
      message.includes('terminated') ||
      message.includes('body timeout') ||
      message.includes('overloaded')) {
    return true;
  }

  // Max turns or silence without completion - retryable
  if (message.includes('max turns') ||
      message.includes('maximum turns') ||
      message.includes('stuck in silence')) {
    return true;
  }

  // Non-retryable errors
  if (message.includes('authentication') ||
      message.includes('invalid prompt') ||
      message.includes('out of memory') ||
      message.includes('permission denied') ||
      message.includes('session limit reached') ||
      message.includes('invalid api key')) {
    return false;
  }

  // Default to non-retryable for unknown errors
  return false;
};

// Get retry delay based on error type and attempt number
/**
 * [목적] 재시도 대기 시간을 계산.
 *
 * [호출자]
 * - agent-executor 재시도 루프
 */
export const getRetryDelay = (error, attempt) => {
  const message = error.message.toLowerCase();

  // Rate limiting gets longer delays
  if (message.includes('rate limit') || message.includes('429')) {
    return Math.min(30000 + (attempt * 10000), 120000); // 30s, 40s, 50s, max 2min
  }

  // Exponential backoff with jitter for other retryable errors
  const baseDelay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
  const jitter = Math.random() * 1000; // 0-1s random
  return Math.min(baseDelay + jitter, 30000); // Max 30s
};
