/**
 * Queue Validator
 *
 * Validates JSON structure for vulnerability queue files.
 * Ported from tools/save_deliverable.js (lines 56-75).
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {string} [message]
 * @property {Object} [data]
 */

/**
 * Validate JSON structure for queue files
 * Queue files must have a 'vulnerabilities' array
 *
 * @param {string} content - JSON string to validate
 * @returns {ValidationResult} ValidationResult with valid flag, optional error message, and parsed data
 */
/**
* [목적] 취약점 큐 JSON의 유효성을 검사하고 필수 스키마 필드를 적용합니다.
*
* [호출 위치]
* - mcp-server/src/tools/save-deliverable.js::saveDeliverable() (함수 상단 부근)
* - 컨텍스트: 큐 유형 전달물에 대한 save_deliverable 도구의 유효성 검사
*
* [출력]
* - saveDeliverable() 함수에 ValidationResult를 반환합니다. 이 함수는 파일 쓰기 및 오류 보고를 제어합니다.
*
* [입력 매개변수]
* - content (문자열): 유효성을 검사할 원시 JSON 텍스트
*
* [반환 값]
* - ValidationResult: { valid: boolean, message?: string, data?: object }
*
* [부작용]
* - 없음 (순수 유효성 검사)
*
* [의존성]
* - JSON.parse를 사용하여 구문 분석하고, 내부 sanitizeJSON() 헬퍼 함수를 ​​사용하여 제어 문자를 처리합니다.
*
* [흐름]
* - 문자열 리터럴 내의 제어 문자를 정제합니다.
* - JSON을 파싱합니다.
* - 취약점 배열의 존재 여부와 유형을 검증합니다.
* - 항목별 심각도 값을 검증합니다.
*
* [오류 처리]
* - 파싱/구조/필드 오류 발생 시 메시지와 함께 valid:false를 반환합니다.
*
* [참고]
* - 각 취약점 항목에 대해 심각도(Critical | High | Medium | Low)를 적용합니다.
*/
export function validateQueueJson(content) {
  // [ROBUST JSON DEFENSE HELPERS]
  const preProcessJSON = (raw) => {
    let cleaned = raw.trim();

    // 1. Strip Markdown code blocks
    if (cleaned.includes('```')) {
      const matches = [...cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
      if (matches.length > 0) {
        cleaned = matches[matches.length - 1][1].trim();
      }
    }

    // 2. Remove comments
    cleaned = cleaned.replace(/\/\/.*/g, '');
    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');

    // 3. Handle ${{placeholder}} hallucination (outside of strings)
    const placeholderRegex = /(?:,\s*)?\$\{\{[^}]+\}\}(?:\s*,)?/g;
    cleaned = cleaned.replace(placeholderRegex, (match) => {
      if (match.startsWith(',') && match.endsWith(',')) return ',';
      return '';
    });

    // 4. Trailing commas
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

    return cleaned;
  };

  const sanitizeJSON = (s) => {
    // Find strings and replace literal control characters within them
    return s.replace(/"(?:[^"\\]|\\.)*"/g, (match) => {
      let sanitized = match.replace(/[\x00-\x1F]/g, (c) => {
        if (c === '\n') return '\\n';
        if (c === '\r') return '\\r';
        if (c === '\t') return '\\t';
        return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
      });
      // Escape invalid backslashes (e.g., in Windows paths or incomplete escapes)
      sanitized = sanitized.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
      return sanitized;
    });
  };

  const repairJSON = (s) => {
    let repaired = s.trim();

    // 1. Fix missing commas between objects/arrays at the same level
    repaired = repaired.replace(/([}\]])\s*([{\[])/g, '$1, $2');

    // 2. Fix missing commas between key-value pairs
    // Matches: "value" "key": or 123 "key":
    repaired = repaired.replace(/("(?:\\[\s\S]|[^"])*"|[0-9\.]+|true|false|null)\s+("(?:\\[\s\S]|[^"])*"\s*:)/g, '$1, $2');

    // 3. Fix comma instead of colon for common keys in queue files
    const commonKeys = ['ID', 'vulnerability_type', 'vulnerability_id', 'severity', 'verdict', 'type', 'description', 'source', 'url_path', 'parameters', 'recommendation'];
    commonKeys.forEach(key => {
      const reg = new RegExp(`("${key}")\\s*,\\s*`, 'g');
      repaired = repaired.replace(reg, '$1: ');
    });

    // 4. Auto-close unterminated strings
    let inString = false;
    let escaped = false;
    for (let i = 0; i < repaired.length; i++) {
      const ch = repaired[i];
      if (ch === '"' && !escaped) {
        inString = !inString;
      }
      escaped = (ch === '\\' && !escaped);
    }
    if (inString) repaired += '"';

    // 5. Balance braces and brackets
    const stack = [];
    inString = false;
    escaped = false;
    for (let i = 0; i < repaired.length; i++) {
      const ch = repaired[i];
      if (ch === '"' && !escaped) {
        inString = !inString;
      }
      escaped = (ch === '\\' && !escaped);

      if (!inString) {
        if (ch === '{' || ch === '[') {
          stack.push(ch);
        } else if (ch === '}' || ch === ']') {
          const last = stack[stack.length - 1];
          if ((ch === '}' && last === '{') || (ch === ']' && last === '[')) {
            stack.pop();
          }
        }
      }
    }
    while (stack.length > 0) {
      const last = stack.pop();
      repaired += (last === '{' ? '}' : ']');
    }

    return repaired;
  };

  // [MULTI-STAGE REPAIR STRATEGY]
  let parsed = null;
  let lastError = null;
  const attempts = [
    (c) => sanitizeJSON(preProcessJSON(c)),
    (c) => repairJSON(sanitizeJSON(preProcessJSON(c))),
    (c) => repairJSON(preProcessJSON(c))
  ];

  for (const attempt of attempts) {
    try {
      const processed = attempt(content);
      parsed = JSON.parse(processed);
      if (parsed && typeof parsed === 'object') break;
    } catch (e) {
      lastError = e.message;
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      valid: false,
      message: `Invalid JSON: ${lastError || 'Parsing failed after multiple repair attempts'}`,
    };
  }

  // Queue files must have a 'vulnerabilities' array
  if (!parsed.vulnerabilities) {
    return {
      valid: false,
      message: `Invalid queue structure: Missing 'vulnerabilities' property. Expected: {"vulnerabilities": [...]}`,
    };
  }

  if (!Array.isArray(parsed.vulnerabilities)) {
    return {
      valid: false,
      message: `Invalid queue structure: 'vulnerabilities' must be an array. Expected: {"vulnerabilities": [...]}`,
    };
  }

  const allowedSeverities = new Set(['Critical', 'High', 'Medium', 'Low']);
  for (let i = 0; i < parsed.vulnerabilities.length; i++) {
    const entry = parsed.vulnerabilities[i];
    if (!entry || typeof entry !== 'object') {
      return {
        valid: false,
        message: `Invalid queue structure: vulnerabilities[${i}] must be an object.`,
      };
    }

    if (entry.severity && typeof entry.severity === 'string') {
      const normalized = entry.severity.charAt(0).toUpperCase() + entry.severity.slice(1).toLowerCase();
      if (allowedSeverities.has(normalized)) {
        entry.severity = normalized; // Normalize in-place
      }
    }

    if (!entry.severity || !allowedSeverities.has(entry.severity)) {
      return {
        valid: false,
        message: `Invalid queue structure: vulnerabilities[${i}].severity must be one of Critical, High, Medium, Low (received: ${entry.severity}).`,
      };
    }
  }

  return {
    valid: true,
    data: parsed,
  };
}

// ═════════════════════════════════════════════
// Category-specific required fields for queue items
// Ensures exploit prompts receive the fields they depend on
// ═════════════════════════════════════════════

const CATEGORY_REQUIRED_FIELDS = {
  SQLI_QUEUE:  ['vulnerability_type', 'source', 'sink_call'],
  CODEI_QUEUE: ['vulnerability_type', 'source', 'sink_call', 'execution_context'],
  SSTI_QUEUE:  ['vulnerability_type', 'template_engine', 'render_call'],
  PATHI_QUEUE: ['vulnerability_type', 'source', 'sink_call'],
  XSS_QUEUE:   ['vulnerability_type', 'source', 'render_context', 'mismatch_reason'],
  AUTH_QUEUE:   ['vulnerability_type', 'source_endpoint', 'suggested_exploit_technique'],
  AUTHZ_QUEUE:  ['vulnerability_type', 'role_context', 'guard_evidence', 'minimal_witness'],
  SSRF_QUEUE:   ['vulnerability_type', 'source', 'suggested_exploit_technique'],
  OSV_QUEUE:    ['vulnerability_type'],
};

/**
 * [목적] 카테고리별 필수 필드 검증 (warning 레벨).
 * 필수 필드 누락 시 valid는 유지하되 warnings를 반환하여
 * exploit 단계 품질 저하를 사전에 감지한다.
 *
 * @param {Object} parsed - validateQueueJson()에서 파싱된 데이터
 * @param {string} queueType - DeliverableType (e.g. 'SQLI_QUEUE')
 * @returns {{ warnings: string[] }}
 */
export function validateCategoryFields(parsed, queueType) {
  const warnings = [];
  const requiredFields = CATEGORY_REQUIRED_FIELDS[queueType];
  if (!requiredFields || !parsed?.vulnerabilities) return { warnings };

  for (let i = 0; i < parsed.vulnerabilities.length; i++) {
    const entry = parsed.vulnerabilities[i];
    const missing = requiredFields.filter(f => !entry[f] || (typeof entry[f] === 'string' && !entry[f].trim()));
    if (missing.length > 0) {
      warnings.push(`vulnerabilities[${i}] (${entry.ID || 'no-ID'}): missing exploit-critical fields: ${missing.join(', ')}`);
    }
  }
  return { warnings };
}
