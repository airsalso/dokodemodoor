/**
 * LLM Provider Abstraction Layer
 *
 * Provides a unified interface for LLM providers (vLLM only)
 * Implements factory pattern for provider instantiation
 */

import { config } from '../config/env.js';
import chalk from 'chalk';

/**
 * Base LLM Provider Interface
 * All providers must implement these methods
 */
export class LLMProvider {
  /**
   * Query the LLM with a prompt and tools
   *
   * @param {string} prompt - The prompt to send to the LLM
   * @param {Array} tools - Available tools for the LLM
   * @param {Object} options - Provider-specific options
   * @returns {AsyncGenerator} Stream of messages
   */
  async *query(prompt, tools, options) {
    throw new Error('query() must be implemented by provider');
  }

  /**
   * Get provider name
   * @returns {string}
   */
  /**
   * [목적] 프로바이더 이름 반환.
   *
   * [호출자]
   * - 에이전트 실행 로깅
   *
   * [반환값]
   * - string
   */
  getName() {
    throw new Error('getName() must be implemented by provider');
  }

  /**
   * Get provider capabilities
   * @returns {Object}
   */
  /**
   * [목적] 프로바이더 지원 기능 정보 반환.
   *
   * [호출자]
   * - 실행 엔진의 옵션 결정 로직
   *
   * [반환값]
   * - object
   */
  getCapabilities() {
    return {
      streaming: true,
      toolCalling: true,
      maxTurns: 100
    };
  }
}

/**
 * Create LLM provider based on configuration
 *
 * @param {string} providerName - Optional provider name override
 * @returns {LLMProvider}
 */
/**
 * [목적] 설정에 맞는 LLM 프로바이더 생성.
 *
 * [호출자]
 * - getProvider()
 *
 * [반환값]
 * - Promise<LLMProvider>
 */
export async function createProvider(providerName = null) {
  console.log(chalk.blue('🤖 Initializing vllm provider...'));
  const { VLLMProvider } = await import('./providers/vllm-provider.js');
  return new VLLMProvider(config.llm.vllm);
}

/**
 * Get singleton provider instance
 */
let providerInstance = null;

/**
 * [목적] 싱글톤 LLM 프로바이더 인스턴스 반환.
 *
 * [호출자]
 * - agent-executor 및 MCP TaskAgent
 *
 * [반환값]
 * - Promise<LLMProvider>
 */
export async function getProvider() {
  if (!providerInstance) {
    providerInstance = await createProvider();
  }
  return providerInstance;
}

/**
 * Reset provider instance (useful for testing)
 */
/**
 * [목적] 프로바이더 인스턴스 초기화(테스트/재시작 용).
 *
 * [호출자]
 * - 테스트/디버깅 유틸리티
 */
export function resetProvider() {
  providerInstance = null;
}
