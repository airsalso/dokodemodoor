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
  try {
    // [CONTROL CHARACTER DEFENSE]
    const sanitizeJSON = (s) => {
      return s.replace(/"(?:[^"\\]|\\.)*"/g, (match) => {
        let sanitized = match.replace(/[\x00-\x1F]/g, (c) => {
          if (c === '\n') return '\\n';
          if (c === '\r') return '\\r';
          if (c === '\t') return '\\t';
          return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
        });
        // Escape invalid backslashes inside string literals (e.g., Windows paths)
        sanitized = sanitized.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
        return sanitized;
      });
    };

    const sanitizedContent = sanitizeJSON(content);
    const parsed = JSON.parse(sanitizedContent);

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
            return {
              valid: false,
              message: `HTTP body too large at vulnerabilities[${j}].evidence[${i}]. Limit ${MAX_BODY_LENGTH} chars.`,
            };
          }
          if (responseHeaders.length > MAX_HEADERS_LENGTH) {
            return {
              valid: false,
              message: `HTTP headers too large at vulnerabilities[${j}].evidence[${i}]. Limit ${MAX_HEADERS_LENGTH} chars.`,
            };
          }
        }

        const description = typeof item.description === 'string' ? item.description : '';
        if (description.length > MAX_TEXT_LENGTH) {
          return {
            valid: false,
            message: `Evidence description too large at vulnerabilities[${j}].evidence[${i}]. Limit ${MAX_TEXT_LENGTH} chars.`,
          };
        }
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
