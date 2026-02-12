/**
 * Evidence Validator
 *
 * Validates JSON structure for exploitation evidence files.
 * Ensures standardized documentation of requests, responses, sessions, and screenshots.
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {string} [message]
 * @property {Object} [data]
 */

/**
 * Validate JSON structure for evidence files
 *
 * @param {string} content - JSON string to validate
 * @returns {ValidationResult} ValidationResult with valid flag, optional error message, and parsed data
 */
export function validateEvidenceJson(content) {
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

    // 3. Fix comma instead of colon for common keys in evidence files
    const commonKeys = ['ID', 'vulnerability_id', 'severity', 'verdict', 'type', 'description', 'evidence', 'reproduction_steps', 'request', 'response', 'status', 'headers', 'body'];
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

  const MAX_BODY_LENGTH = 2000;
  const MAX_TEXT_LENGTH = 2000;
  const MAX_HEADERS_LENGTH = 8000;

  // Root validation
  if (!parsed.vulnerabilities || !Array.isArray(parsed.vulnerabilities)) {
    return {
      valid: false,
      message: `Invalid evidence structure: Missing 'vulnerabilities' array property.`,
    };
  }

  if (parsed.vulnerabilities.length === 0) {
    return {
      valid: false,
      message: `Invalid evidence structure: 'vulnerabilities' must contain at least one entry.`,
    };
  }

  // Validate each vulnerability entry
  for (let j = 0; j < parsed.vulnerabilities.length; j++) {
    const vuln = parsed.vulnerabilities[j];
    const requiredFields = ['vulnerability_id', 'evidence', 'reproduction_steps'];
    for (const field of requiredFields) {
      if (!vuln[field]) {
        return {
          valid: false,
          message: `Invalid evidence structure at vulnerabilities[${j}]: Missing '${field}' property.`,
        };
      }
    }

    if (!Array.isArray(vuln.evidence)) {
      return {
        valid: false,
        message: `Invalid evidence structure at vulnerabilities[${j}]: 'evidence' must be an array.`,
      };
    }

    const validVerdicts = ['EXPLOITED', 'BLOCKED_BY_SECURITY', 'POTENTIAL'];
    if (!validVerdicts.includes(vuln.verdict)) {
      return {
        valid: false,
        message: `Invalid verdict at vulnerabilities[${j}]: '${vuln.verdict}'. Valid: ${validVerdicts.join(', ')}`,
      };
    }

    // Validate evidence items
    for (let i = 0; i < vuln.evidence.length; i++) {
      const item = vuln.evidence[i];
      if (!item.type || !item.description) {
        return {
          valid: false,
          message: `Invalid evidence item at vulnerabilities[${j}].evidence[${i}]: Missing 'type' or 'description'.`,
        };
      }

      const validTypes = ['http_request_response', 'screenshot', 'session_state', 'bash_output', 'code_snippet', 'other'];
      if (!validTypes.includes(item.type)) {
        return {
          valid: false,
          message: `Invalid evidence type at vulnerabilities[${j}].evidence[${i}]: '${item.type}'.`,
        };
      }

      if (item.type === 'http_request_response' && (!item.request || !item.response)) {
        return {
          valid: false,
          message: `Evidence item at vulnerabilities[${j}].evidence[${i}] (http_request_response) requires 'request' and 'response'.`,
        };
      }

      if (item.type === 'screenshot' && !item.path) {
        return {
          valid: false,
          message: `Evidence item at vulnerabilities[${j}].evidence[${i}] (screenshot) requires 'path' property pointing to the image.`,
        };
      }

      if (item.type === 'http_request_response') {
        const requestBody = typeof item.request?.body === 'string' ? item.request.body : '';
        const responseBody = typeof item.response?.body === 'string' ? item.response.body : '';
        const responseHeaders = item.response?.headers ? JSON.stringify(item.response.headers) : '';
        if (requestBody.length > MAX_BODY_LENGTH || responseBody.length > MAX_BODY_LENGTH) {
          // Truncate instead of failing if it's just a size issue during validation
          if (item.request && typeof item.request.body === 'string') item.request.body = item.request.body.slice(0, MAX_BODY_LENGTH) + '... [truncated]';
          if (item.response && typeof item.response.body === 'string') item.response.body = item.response.body.slice(0, MAX_BODY_LENGTH) + '... [truncated]';
        }
        if (responseHeaders.length > MAX_HEADERS_LENGTH) {
          item.response.headers = { note: 'headers truncated; too large' };
        }
      }

      const description = typeof item.description === 'string' ? item.description : '';
      if (description.length > MAX_TEXT_LENGTH) {
        item.description = item.description.slice(0, MAX_TEXT_LENGTH) + '... [truncated]';
      }
    }
  }

  return {
    valid: true,
    data: parsed,
  };
}
