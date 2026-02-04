import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Execution context for DokodemoDoor agents
 * Used to isolate state (agent name, target dir) during parallel execution
 */
export const agentContext = new AsyncLocalStorage();

/**
 * [목적] 현재 실행 컨텍스트의 에이전트 이름을 조회.
 *
 * [호출자]
 * - vLLM provider 및 tool 저장 로직
 *
 * [반환값]
 * - string
 */
export function getAgentName() {
  const store = agentContext.getStore();
  return store?.agentName || global.__DOKODEMODOOR_AGENT_NAME || 'generic';
}

/**
 * [목적] 현재 실행 컨텍스트의 대상 디렉터리를 조회.
 *
 * [호출자]
 * - save_deliverable 파일 저장 로직
 *
 * [반환값]
 * - string
 *
 * [에러 처리]
 * - 컨텍스트 누락 시 Error 발생
 */
export function getTargetDir() {
  const store = agentContext.getStore();
  const targetDir = store?.targetDir || global.__DOKODEMODOOR_TARGET_DIR;
  if (!targetDir) {
    throw new Error('Target directory is not set in execution context.');
  }
  return targetDir;
}

/**
 * [목적] 에이전트 컨텍스트에서 함수를 실행.
 *
 * [호출자]
 * - agent-executor.js
 *
 * [입력 파라미터]
 * - context (object): { agentName, targetDir, auditSession }
 * - fn (function)
 *
 * [반환값]
 * - any
 */
export function runWithContext(context, fn) {
  return agentContext.run(context, fn);
}

/**
 * [목적] 현재 컨텍스트의 AuditSession 조회.
 *
 * [호출자]
 * - vLLM provider 로그/메트릭 기록
 *
 * [반환값]
 * - object|null
 */
export function getAuditSession() {
  const store = agentContext.getStore();
  return store?.auditSession || null;
}
