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
        return match.replace(/[\x00-\x1F]/g, (c) => {
          if (c === '\n') return '\\n';
          if (c === '\r') return '\\r';
          if (c === '\t') return '\\t';
          return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
        });
      });
    };

    const sanitizedContent = sanitizeJSON(content);
    const parsed = JSON.parse(sanitizedContent);

    // Root validation
    if (!parsed.vulnerabilities || !Array.isArray(parsed.vulnerabilities)) {
      return {
        valid: false,
        message: `Invalid evidence structure: Missing 'vulnerabilities' array property.`,
      };
    }

    if (parsed.vulnerabilities.length === 0) {
       // Allow empty array if no vulns were successfully evidence
       return { valid: true, data: parsed };
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
