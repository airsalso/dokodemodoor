/**
 * Unified Audit & Metrics System
 *
 * Public API for the audit system. Provides crash-safe, append-only logging
 * and comprehensive metrics tracking for DokodemoDoor penetration testing sessions.
 *
 * IMPORTANT: Session objects must have an 'id' field (NOT 'sessionId')
 * Example: { id: "uuid", webUrl: "...", repoPath: "..." }
 *
 * @module audit
 */

/**
 * [목적] 감사/메트릭 시스템의 공개 엔트리 포인트.
 *
 * [호출자]
 * - checkpoint-manager, agent-executor 등
 */
export { AuditSession } from './audit-session.js';
export { AgentLogger } from './logger.js';
export { MetricsTracker } from './metrics-tracker.js';
export * as AuditUtils from './utils.js';
