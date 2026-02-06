/**
 * Deliverable Type Definitions
 *
 * Maps deliverable types to their filenames and defines validation requirements.
 * Must match the exact mappings from tools/save_deliverable.js.
 */

/**
 * @typedef {Object} DeliverableType
 * @property {string} CODE_ANALYSIS
 * @property {string} RECON
 * @property {string} INJECTION_ANALYSIS
 * @property {string} INJECTION_QUEUE
 * @property {string} XSS_ANALYSIS
 * @property {string} XSS_QUEUE
 * @property {string} AUTH_ANALYSIS
 * @property {string} AUTH_QUEUE
 * @property {string} AUTHZ_ANALYSIS
 * @property {string} AUTHZ_QUEUE
 * @property {string} SSRF_ANALYSIS
 * @property {string} SSRF_QUEUE
 * @property {string} INJECTION_EVIDENCE
 * @property {string} XSS_EVIDENCE
 * @property {string} AUTH_EVIDENCE
 * @property {string} AUTHZ_EVIDENCE
 * @property {string} SSRF_EVIDENCE
 */

export const DeliverableType = {
 // Master Recon Map (Primary deliverable)
  RECON: 'RECON',
  RECON_VERIFY: 'RECON_VERIFY',

  // Vulnerability analysis agents
  SQLI_ANALYSIS: 'SQLI_ANALYSIS',
  SQLI_QUEUE: 'SQLI_QUEUE',

  CODEI_ANALYSIS: 'CODEI_ANALYSIS',
  CODEI_QUEUE: 'CODEI_QUEUE',

  SSTI_ANALYSIS: 'SSTI_ANALYSIS',
  SSTI_QUEUE: 'SSTI_QUEUE',

  PATHI_ANALYSIS: 'PATHI_ANALYSIS',
  PATHI_QUEUE: 'PATHI_QUEUE',

  XSS_ANALYSIS: 'XSS_ANALYSIS',
  XSS_QUEUE: 'XSS_QUEUE',

  AUTH_ANALYSIS: 'AUTH_ANALYSIS',
  AUTH_QUEUE: 'AUTH_QUEUE',

  AUTHZ_ANALYSIS: 'AUTHZ_ANALYSIS',
  AUTHZ_QUEUE: 'AUTHZ_QUEUE',

  SSRF_ANALYSIS: 'SSRF_ANALYSIS',
  SSRF_QUEUE: 'SSRF_QUEUE',

  // Exploitation agents
  SQLI_EVIDENCE: 'SQLI_EVIDENCE',
  CODEI_EVIDENCE: 'CODEI_EVIDENCE',
  SSTI_EVIDENCE: 'SSTI_EVIDENCE',
  PATHI_EVIDENCE: 'PATHI_EVIDENCE',
  XSS_EVIDENCE: 'XSS_EVIDENCE',
  AUTH_EVIDENCE: 'AUTH_EVIDENCE',
  AUTHZ_EVIDENCE: 'AUTHZ_EVIDENCE',
  SSRF_EVIDENCE: 'SSRF_EVIDENCE',

  // Reporting and specialized tasks
  FINAL_REPORT: 'FINAL_REPORT',
  SUMMARY_REPORT: 'SUMMARY_REPORT',
  OSV_REPORT: 'OSV_REPORT',
  OSV_QUEUE: 'OSV_QUEUE',

  // API Fuzzing & Authentication
  API_FUZZ_REPORT: 'API_FUZZ_REPORT',
  AUTH_SESSION: 'AUTH_SESSION',

  // Pre-recon agent (Bottom to prevent accidental reuse in later phases)
  CODE_ANALYSIS: 'CODE_ANALYSIS',
};


/**
 * [목적] Deliverable 타입과 파일명 매핑 정의.
 *
 * [호출자]
 * - save_deliverable 도구 및 파일 저장 로직
 *
 * [출력 대상]
 * - 파일명 매핑 객체 제공
 */
export const DELIVERABLE_FILENAMES = {
  [DeliverableType.CODE_ANALYSIS]: 'code_analysis_deliverable.md',
  [DeliverableType.RECON]: 'recon_deliverable.md',
  [DeliverableType.RECON_VERIFY]: 'recon_verify_deliverable.md',
  [DeliverableType.SQLI_ANALYSIS]: 'sqli_analysis_deliverable.md',
  [DeliverableType.SQLI_QUEUE]: 'sqli_exploitation_queue.json',
  [DeliverableType.CODEI_ANALYSIS]: 'codei_analysis_deliverable.md',
  [DeliverableType.CODEI_QUEUE]: 'codei_exploitation_queue.json',
  [DeliverableType.SSTI_ANALYSIS]: 'ssti_analysis_deliverable.md',
  [DeliverableType.SSTI_QUEUE]: 'ssti_exploitation_queue.json',
  [DeliverableType.PATHI_ANALYSIS]: 'pathi_analysis_deliverable.md',
  [DeliverableType.PATHI_QUEUE]: 'pathi_exploitation_queue.json',
  [DeliverableType.XSS_ANALYSIS]: 'xss_analysis_deliverable.md',
  [DeliverableType.XSS_QUEUE]: 'xss_exploitation_queue.json',
  [DeliverableType.AUTH_ANALYSIS]: 'auth_analysis_deliverable.md',
  [DeliverableType.AUTH_QUEUE]: 'auth_exploitation_queue.json',
  [DeliverableType.AUTHZ_ANALYSIS]: 'authz_analysis_deliverable.md',
  [DeliverableType.AUTHZ_QUEUE]: 'authz_exploitation_queue.json',
  [DeliverableType.SSRF_ANALYSIS]: 'ssrf_analysis_deliverable.md',
  [DeliverableType.SSRF_QUEUE]: 'ssrf_exploitation_queue.json',
  [DeliverableType.SQLI_EVIDENCE]: 'sqli_exploitation_evidence.json',
  [DeliverableType.CODEI_EVIDENCE]: 'codei_exploitation_evidence.json',
  [DeliverableType.SSTI_EVIDENCE]: 'ssti_exploitation_evidence.json',
  [DeliverableType.PATHI_EVIDENCE]: 'pathi_exploitation_evidence.json',
  [DeliverableType.XSS_EVIDENCE]: 'xss_exploitation_evidence.json',
  [DeliverableType.AUTH_EVIDENCE]: 'auth_exploitation_evidence.json',
  [DeliverableType.AUTHZ_EVIDENCE]: 'authz_exploitation_evidence.json',
  [DeliverableType.SSRF_EVIDENCE]: 'ssrf_exploitation_evidence.json',
  [DeliverableType.FINAL_REPORT]: 'comprehensive_security_assessment_report.md',
  [DeliverableType.SUMMARY_REPORT]: 'pentest_summary.md',
  [DeliverableType.OSV_REPORT]: 'osv_analysis_deliverable.md',
  [DeliverableType.OSV_QUEUE]: 'osv_exploitation_queue.json',
  [DeliverableType.API_FUZZ_REPORT]: 'api_fuzzer_deliverable.md',
  [DeliverableType.AUTH_SESSION]: 'auth_session.json',
};


/**
 * [목적] 큐(JSON) 검증이 필요한 타입 목록 정의.
 *
 * [호출자]
 * - save_deliverable / queue-validator
 */
export const QUEUE_TYPES = [
  DeliverableType.SQLI_QUEUE,
  DeliverableType.CODEI_QUEUE,
  DeliverableType.SSTI_QUEUE,
  DeliverableType.PATHI_QUEUE,
  DeliverableType.XSS_QUEUE,
  DeliverableType.AUTH_QUEUE,
  DeliverableType.AUTHZ_QUEUE,
  DeliverableType.SSRF_QUEUE,
  DeliverableType.OSV_QUEUE,
];

/**
 * [목적] 증거(JSON) 검증이 필요한 타입 목록 정의.
 */
export const EVIDENCE_TYPES = [
  DeliverableType.SQLI_EVIDENCE,
  DeliverableType.CODEI_EVIDENCE,
  DeliverableType.SSTI_EVIDENCE,
  DeliverableType.PATHI_EVIDENCE,
  DeliverableType.XSS_EVIDENCE,
  DeliverableType.AUTH_EVIDENCE,
  DeliverableType.AUTHZ_EVIDENCE,
  DeliverableType.SSRF_EVIDENCE,
];

/**
 * [목적] 타입이 Queue인지 판별.
 */
export function isQueueType(type) {
  return QUEUE_TYPES.includes(type);
}

/**
 * [목적] 타입이 Evidence인지 판별.
 */
export function isEvidenceType(type) {
  return EVIDENCE_TYPES.includes(type);
}

/**
 * @typedef {Object} VulnerabilityQueue
 * @property {Array<Object>} vulnerabilities - Array of vulnerability objects
 */
