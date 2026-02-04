/**
 * Audit System Utilities
 *
 * Core utility functions for path generation, atomic writes, and formatting.
 * All functions are pure and crash-safe.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get DokodemoDoor repository root
export const DOKODEMODOOR_ROOT = path.resolve(__dirname, '..', '..');
export const AUDIT_LOGS_DIR = path.join(DOKODEMODOOR_ROOT, 'audit-logs');

/**
 * Generate standardized session identifier: {hostname}_{sessionId}
 * @param {Object} sessionMetadata - Session metadata from DokodemoDoor store
 * @param {string} sessionMetadata.id - UUID session ID
 * @param {string} sessionMetadata.webUrl - Target web URL
 * @returns {string} Formatted session identifier
 */
/**
 * [목적] 세션 식별자 문자열 생성.
 *
 * [호출자]
 * - generateAuditPath()
 *
 * [입력 파라미터]
 * - sessionMetadata (object)
 *
 * [반환값]
 * - string
 */
export function generateSessionIdentifier(sessionMetadata) {
  const { id, webUrl } = sessionMetadata;
  const hostname = new URL(webUrl).hostname.replace(/[^a-zA-Z0-9-]/g, '-');
  return `${hostname}_${id}`;
}

/**
 * Generate path to audit log directory for a session
 * @param {Object} sessionMetadata - Session metadata
 * @returns {string} Absolute path to session audit directory
 */
/**
 * [목적] 세션별 audit 경로 생성.
 *
 * [호출자]
 * - AuditSession 초기화 및 로그 기록
 *
 * [반환값]
 * - string
 */
export function generateAuditPath(sessionMetadata) {
  const sessionIdentifier = generateSessionIdentifier(sessionMetadata);
  return path.join(AUDIT_LOGS_DIR, sessionIdentifier);
}

/**
 * Generate path to agent log file
 * @param {Object} sessionMetadata - Session metadata
 * @param {string} agentName - Name of the agent
 * @param {number} timestamp - Timestamp (ms since epoch)
 * @param {number} attemptNumber - Attempt number (1, 2, 3, ...)
 * @returns {string} Absolute path to agent log file
 */
/**
 * [목적] 에이전트 로그 파일 경로 생성.
 *
 * [호출자]
 * - AuditSession 로그 기록
 */
export function generateLogPath(sessionMetadata, agentName, timestamp, attemptNumber) {
  const auditPath = generateAuditPath(sessionMetadata);
  const filename = `${timestamp}_${agentName}_attempt-${attemptNumber}.log`;
  return path.join(auditPath, 'agents', filename);
}

/**
 * Generate path to human-readable debug log file
 * @param {Object} sessionMetadata - Session metadata
 * @param {string} agentName - Name of the agent
 * @param {number} timestamp - Timestamp (ms since epoch)
 * @param {number} attemptNumber - Attempt number (1, 2, 3, ...)
 * @returns {string} Absolute path to agent debug log file
 */
export function generateDebugLogPath(sessionMetadata, agentName, timestamp, attemptNumber) {
  const auditPath = generateAuditPath(sessionMetadata);
  const filename = `${timestamp}_${agentName}_attempt-${attemptNumber}.debug.log`;
  return path.join(auditPath, 'agents', filename);
}

/**
 * Generate path to prompt snapshot file
 * @param {Object} sessionMetadata - Session metadata
 * @param {string} agentName - Name of the agent
 * @returns {string} Absolute path to prompt file
 */
/**
 * [목적] 프롬프트 스냅샷 파일 경로 생성.
 *
 * [호출자]
 * - AuditSession 프롬프트 저장
 */
export function generatePromptPath(sessionMetadata, agentName) {
  const auditPath = generateAuditPath(sessionMetadata);
  return path.join(auditPath, 'prompts', `${agentName}.md`);
}

/**
 * Generate path to session.json file
 * @param {Object} sessionMetadata - Session metadata
 * @returns {string} Absolute path to session.json
 */
/**
 * [목적] session.json 경로 생성.
 *
 * [호출자]
 * - AuditSession 메트릭 저장
 */
export function generateSessionJsonPath(sessionMetadata) {
  const auditPath = generateAuditPath(sessionMetadata);
  return path.join(auditPath, 'session.json');
}

/**
 * Ensure directory exists (idempotent, race-safe)
 * @param {string} dirPath - Directory path to create
 * @returns {Promise<void>}
 */
/**
 * [목적] 디렉터리 존재 보장(재진입 안전).
 *
 * [호출자]
 * - initializeAuditStructure()
 */
export async function ensureDirectory(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    // Ignore EEXIST errors (race condition safe)
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Atomic write using temp file + rename pattern
 * Guarantees no partial writes or corruption on crash
 * @param {string} filePath - Target file path
 * @param {Object|string} data - Data to write (will be JSON.stringified if object)
 * @returns {Promise<void>}
 */
/**
 * [목적] 임시 파일 + rename으로 원자적 쓰기 수행.
 *
 * [호출자]
 * - AuditSession 기록 저장
 */
export async function atomicWrite(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  try {
    // Write to temp file
    await fs.writeFile(tempPath, content, 'utf8');

    // Atomic rename (POSIX guarantee: atomic on same filesystem)
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tempPath);
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration (e.g., "2m 34s", "45s", "1.2s")
 */
/**
 * [목적] 밀리초를 사람이 읽기 쉬운 시간으로 변환.
 *
 * [호출자]
 * - 리포팅/로그 표시
 */
export function formatDuration(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

import { getLocalISOString } from '../utils/time-utils.js';

/**
 * Format timestamp to ISO 8601 string (local timezone)
 * @param {number} [timestamp] - Unix timestamp in ms (defaults to now)
 * @returns {string} Local ISO 8601 formatted string
 */
/**
 * [목적] 타임스탬프를 로컬 ISO 문자열로 변환.
 *
 * [호출자]
 * - 감사 로그 기록
 */
export function formatTimestamp(timestamp = Date.now()) {
  return getLocalISOString(timestamp);
}

/**
 * Calculate percentage
 * @param {number} part - Part value
 * @param {number} total - Total value
 * @returns {number} Percentage (0-100)
 */
/**
 * [목적] 퍼센트 계산.
 *
 * [호출자]
 * - 상태/통계 출력
 */
export function calculatePercentage(part, total) {
  if (total === 0) return 0;
  return (part / total) * 100;
}

/**
 * Read and parse JSON file
 * @param {string} filePath - Path to JSON file
 * @returns {Promise<Object>} Parsed JSON data
 */
/**
 * [목적] JSON 파일 읽기 및 파싱.
 *
 * [호출자]
 * - AuditSession, 유틸리티
 */
export async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

/**
 * Check if file exists
 * @param {string} filePath - Path to check
 * @returns {Promise<boolean>} True if file exists
 */
/**
 * [목적] 파일 존재 여부 확인.
 *
 * [호출자]
 * - 감사 구조 초기화, 상태 점검
 */
export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize audit directory structure for a session
 * Creates: audit-logs/{sessionId}/, agents/, prompts/
 * @param {Object} sessionMetadata - Session metadata
 * @returns {Promise<void>}
 */
/**
 * [목적] 세션용 audit 디렉터리 구조 생성.
 *
 * [호출자]
 * - AuditSession.initialize()
 */
export async function initializeAuditStructure(sessionMetadata) {
  const auditPath = generateAuditPath(sessionMetadata);
  const agentsPath = path.join(auditPath, 'agents');
  const promptsPath = path.join(auditPath, 'prompts');

  await ensureDirectory(auditPath);
  await ensureDirectory(agentsPath);
  await ensureDirectory(promptsPath);
}
