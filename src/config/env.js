/**
 * Environment Configuration Loader
 *
 * Loads and validates environment variables from .env file
 * Provides typed configuration object for the application
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '../../.env');

// Load .env file if it exists
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

/**
 * [목적] 정수 환경변수를 기본값과 함께 파싱.
 *
 * [호출자]
 * - config 객체 생성
 */
const parseIntDecimal = (val, defaultValue) => {
  if (!val) return defaultValue;
  const parsed = Number.parseInt(val, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
};

/**
 * [목적] 불리언 환경변수 파싱.
 */
function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * [목적] 정수 환경변수 파싱.
 */
function parseInt(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * [목적] 실수 환경변수 파싱.
 */
function parseFloat(value, defaultValue) {
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * [목적] 콤마 구분 리스트 파싱.
 */
function parseList(value, defaultValue = []) {
  if (!value || value.trim() === '') {
    return defaultValue;
  }
  return value.split(',').map(item => item.trim()).filter(item => item !== '');
}

/**
 * Application configuration object
 */
export const config = {
  // LLM Provider Configuration
  llm: {
    // Provider selection: vLLM only
    provider: 'vllm',

    // vLLM configuration
    vllm: {
      baseURL: process.env.VLLM_BASE_URL || 'http://localhost:8000/v1',
      model: process.env.VLLM_MODEL || 'openai/gpt-oss-20b',
      apiKey: process.env.VLLM_API_KEY || 'EMPTY',
      temperature: parseFloat(process.env.VLLM_TEMPERATURE, 0.7),
      maxTurns: parseInt(process.env.VLLM_MAX_TURNS, 100),
      maxPromptChars: parseIntDecimal(process.env.VLLM_MAX_PROMPT_CHARS, 32000),
      promptTokenPrice: parseFloat(process.env.VLLM_PROMPT_TOKEN_PRICE, 0.0), // USD per 1M tokens
      completionTokenPrice: parseFloat(process.env.VLLM_COMPLETION_TOKEN_PRICE, 0.0) // USD per 1M tokens
    }
  },

  // DokodemoDoor Framework Configuration
  dokodemodoor: {

    debug: parseBoolean(process.env.DOKODEMODOOR_DEBUG, false),
    disableLoader: parseBoolean(process.env.DOKODEMODOOR_DISABLE_LOADER, false),
    logPromptSizes: parseBoolean(process.env.DOKODEMODOOR_PRINT_LOG_PROMPT_SIZES, false),
    skipToolCheck: parseBoolean(process.env.DOKODEMODOOR_SKIP_TOOL_CHECK, false),
    skipNmap: parseBoolean(process.env.DOKODEMODOOR_SKIP_NMAP, false),
    skipSubfinder: parseBoolean(process.env.DOKODEMODOOR_SKIP_SUBFINDER, false),
    skipWhatweb: parseBoolean(process.env.DOKODEMODOOR_SKIP_WHATWEB, false),
    skipSchemathesis: parseBoolean(process.env.DOKODEMODOOR_SKIP_SCHEMATHESIS, false),
    skipSemgrep: parseBoolean(process.env.DOKODEMODOOR_SKIP_SEMGREP, false),
    skipOsv: parseBoolean(process.env.DOKODEMODOOR_SKIP_OSV, false),
    preReconParallel: parseBoolean(process.env.DOKODEMODOOR_PRE_RECON_PARALLEL, false),
    subAgentTruncateLimit: parseIntDecimal(process.env.DOKODEMODOOR_SUB_AGENT_TRUNCATE_LIMIT, 50000),
    subAgentMaxTurns: parseIntDecimal(process.env.DOKODEMODOOR_SUB_AGENT_MAX_TURNS, 50),
    externalTestDomain: process.env.EXTERNAL_TEST_DOMAIN || 'http://attacker-controlled.com',

    // Agent-specific overrides (optional)
    agentMaxTurns: {
      'osv-analysis': parseIntDecimal(process.env.DOKODEMODOOR_OSV_MAX_TURNS, null),
      'recon': parseIntDecimal(process.env.DOKODEMODOOR_RECON_MAX_TURNS, null),
      'pre-recon': parseIntDecimal(process.env.DOKODEMODOOR_PRERECON_MAX_TURNS, null),
      'api-fuzzer': parseIntDecimal(process.env.DOKODEMODOOR_API_FUZZER_MAX_TURNS, null),
      'report': parseIntDecimal(process.env.DOKODEMODOOR_REPORT_MAX_TURNS, null),
    },


    contextCompressionThreshold: parseIntDecimal(process.env.DOKODEMODOOR_CONTEXT_COMPRESSION_THRESHOLD, 30000),
    contextCompressionWindow: parseIntDecimal(process.env.DOKODEMODOOR_CONTEXT_COMPRESSION_WINDOW, 15),
    agentDebugLog: parseBoolean(process.env.DOKODEMODOOR_AGENT_DEBUG_LOG, false),

    // Pipeline control
    skipExploitation: parseBoolean(process.env.DOKODEMODOOR_SKIP_EXPLOITATION, false),

    // Playwright Configuration
    playwrightHeadless: parseBoolean(process.env.DOKODEMODOOR_PLAYWRIGHT_HEADLESS, true),

    // Concurrency control for parallel phases (vuln, exploit)
    parallelLimit: parseIntDecimal(process.env.DOKODEMODOOR_PARALLEL_LIMIT, 5)
  }
};

/**
 * Validate configuration
 * Throws error if required configuration is missing
 */
/**
 * [목적] 필수 환경변수 검증.
 *
 * [호출자]
 * - 모듈 로드 시 자동 실행
 */
export function validateConfig() {
  const provider = config.llm.provider;

  if (!config.llm.vllm.baseURL) {
    throw new Error('vLLM provider requires VLLM_BASE_URL');
  }
  if (!config.llm.vllm.model) {
    throw new Error('vLLM provider requires VLLM_MODEL');
  }

  return true;
}

/**
 * Get current provider name
 */
/**
 * [목적] 현재 LLM 프로바이더 이름 반환.
 */
export function getCurrentProvider() {
  return config.llm.provider;
}

/**
 * Check if using vLLM provider
 */
/**
 * [목적] vLLM 사용 여부 반환.
 */
export function isVLLMProvider() {
  return true;
}

// Auto-validate on import
try {
  validateConfig();
} catch (error) {
  console.error(`⚠️  Configuration validation failed: ${error.message}`);
  console.error(`   Please check your .env file or environment variables`);
  // Don't throw - allow application to start and show better error messages
}
