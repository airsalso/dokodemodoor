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
  try {
    // [ROBUST JSON DEFENSE]
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
      // If LLM tried to use a placeholder like ${{EXISTING_DATA}}, remove it and its comma if needed
      // This regex looks for ${{...}} not enclosed in double quotes (best effort)
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
        return match.replace(/[\x00-\x1F]/g, (c) => {
          if (c === '\n') return '\\n';
          if (c === '\r') return '\\r';
          if (c === '\t') return '\\t';
          return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
        });
      });
    };

    const cleanedContent = preProcessJSON(content);
    const sanitizedContent = sanitizeJSON(cleanedContent);
    const parsed = JSON.parse(sanitizedContent);

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
  } catch (error) {
    return {
      valid: false,
      message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
