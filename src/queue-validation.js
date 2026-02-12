import { fs, path } from 'zx';
import { PentestError } from './error-handling.js';

// Vulnerability type configuration as immutable data
const VULN_TYPE_CONFIG = Object.freeze({
  sqli: Object.freeze({
    deliverable: 'sqli_analysis_deliverable.md',
    queue: 'sqli_exploitation_queue.json'
  }),
  codei: Object.freeze({
    deliverable: 'codei_analysis_deliverable.md',
    queue: 'codei_exploitation_queue.json'
  }),
  ssti: Object.freeze({
    deliverable: 'ssti_analysis_deliverable.md',
    queue: 'ssti_exploitation_queue.json'
  }),
  pathi: Object.freeze({
    deliverable: 'pathi_analysis_deliverable.md',
    queue: 'pathi_exploitation_queue.json'
  }),
  xss: Object.freeze({
    deliverable: 'xss_analysis_deliverable.md',
    queue: 'xss_exploitation_queue.json'
  }),
  auth: Object.freeze({
    deliverable: 'auth_analysis_deliverable.md',
    queue: 'auth_exploitation_queue.json'
  }),
  ssrf: Object.freeze({
    deliverable: 'ssrf_analysis_deliverable.md',
    queue: 'ssrf_exploitation_queue.json'
  }),
  authz: Object.freeze({
    deliverable: 'authz_analysis_deliverable.md',
    queue: 'authz_exploitation_queue.json'
  })
});

// Functional composition utilities - async pipe for promise chain
const pipe = (...fns) => x => fns.reduce(async (v, f) => f(await v), x);

// Pure function to create validation rule
const createValidationRule = (predicate, errorMessage, retryable = true) =>
  Object.freeze({ predicate, errorMessage, retryable });

// Validation rules for file existence (following QUEUE_VALIDATION_FLOW.md)
const fileExistenceRules = Object.freeze([
  // Rule 1: Neither deliverable nor queue exists
  createValidationRule(
    ({ deliverableExists, queueExists }) => deliverableExists || queueExists,
    'Analysis failed: Neither deliverable nor queue file exists. Analysis agent must create both files.'
  ),
  // Rule 2: Queue doesn't exist but deliverable exists
  createValidationRule(
    ({ deliverableExists, queueExists }) => !(!queueExists && deliverableExists),
    'Analysis incomplete: Deliverable exists but queue file missing. Analysis agent must create both files.'
  ),
  // Rule 3: Queue exists but deliverable doesn't exist
  createValidationRule(
    ({ deliverableExists, queueExists }) => !(queueExists && !deliverableExists),
    'Analysis incomplete: Queue exists but deliverable file missing. Analysis agent must create both files.'
  )
]);

// Pure function to create file paths
/**
 * [목적] 취약점 타입에 따른 deliverable/queue 경로 생성.
 *
 * [호출자]
 * - validateQueueAndDeliverable()
 */
const createPaths = (vulnType, sourceDir) => {
  const config = VULN_TYPE_CONFIG[vulnType];
  if (!config) {
    return {
      error: new PentestError(
        `Unknown vulnerability type: ${vulnType}`,
        'validation',
        false,
        { vulnType }
      )
    };
  }

  return Object.freeze({
    vulnType,
    deliverable: path.join(sourceDir, 'deliverables', config.deliverable),
    queue: path.join(sourceDir, 'deliverables', config.queue),
    sourceDir
  });
};

// Pure function to check file existence
/**
 * [목적] deliverable/queue 파일 존재 여부 확인.
 *
 * [호출자]
 * - validateQueueAndDeliverable()
 */
const checkFileExistence = async (paths) => {
  if (paths.error) return paths;

  const [deliverableExists, queueExists] = await Promise.all([
    fs.pathExists(paths.deliverable),
    fs.pathExists(paths.queue)
  ]);

  return Object.freeze({
    ...paths,
    existence: Object.freeze({ deliverableExists, queueExists })
  });
};

// Pure function to validate existence rules
/**
 * [목적] 파일 존재 규칙 검증.
 *
 * [호출자]
 * - validateQueueAndDeliverable()
 */
const validateExistenceRules = (pathsWithExistence) => {
  if (pathsWithExistence.error) return pathsWithExistence;

  const { existence, vulnType } = pathsWithExistence;

  // Find the first rule that fails
  const failedRule = fileExistenceRules.find(rule => !rule.predicate(existence));

  if (failedRule) {
    return {
      ...pathsWithExistence,
      error: new PentestError(
        `${failedRule.errorMessage} (${vulnType})`,
        'validation',
        failedRule.retryable,
        {
          vulnType,
          deliverablePath: pathsWithExistence.deliverable,
          queuePath: pathsWithExistence.queue,
          existence
        }
      )
    };
  }

  return pathsWithExistence;
};

// Pure function to validate queue structure
/**
 * [목적] queue JSON 구조(배열) 유효성 검사.
 *
 * [호출자]
 * - validateQueueContent()
 */
const validateQueueStructure = (content) => {
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
  let lastError = null;
  const attempts = [
    (c) => sanitizeJSON(preProcessJSON(c)),
    (c) => repairJSON(sanitizeJSON(preProcessJSON(c))),
    (c) => repairJSON(preProcessJSON(c))
  ];

  for (const attempt of attempts) {
    try {
      const processed = attempt(content);
      const parsed = JSON.parse(processed);
      if (parsed && typeof parsed === 'object') {
        return Object.freeze({
          valid: parsed.vulnerabilities && Array.isArray(parsed.vulnerabilities),
          data: parsed,
          error: null
        });
      }
    } catch (e) {
      lastError = e.message;
    }
  }

  return Object.freeze({
    valid: false,
    data: null,
    error: lastError || 'JSON parsing failed after multiple repair attempts'
  });
};

// Pure function to read and validate queue content
/**
 * [목적] queue 파일을 읽고 구조를 검증.
 *
 * [호출자]
 * - validateQueueAndDeliverable()
 */
const validateQueueContent = async (pathsWithExistence) => {
  if (pathsWithExistence.error) return pathsWithExistence;

  try {
    const queueContent = await fs.readFile(pathsWithExistence.queue, 'utf8');
    const queueValidation = validateQueueStructure(queueContent);

    if (!queueValidation.valid) {
      // Rule 6: Both exist, queue invalid
      return {
        ...pathsWithExistence,
        error: new PentestError(
          queueValidation.error
            ? `Queue validation failed for ${pathsWithExistence.vulnType}: Invalid JSON structure. Analysis agent must fix queue format.`
            : `Queue validation failed for ${pathsWithExistence.vulnType}: Missing or invalid 'vulnerabilities' array. Analysis agent must fix queue structure.`,
          'validation',
          true, // retryable
          {
            vulnType: pathsWithExistence.vulnType,
            queuePath: pathsWithExistence.queue,
            originalError: queueValidation.error,
            queueStructure: queueValidation.data ? Object.keys(queueValidation.data) : []
          }
        )
      };
    }

    return Object.freeze({
      ...pathsWithExistence,
      queueData: queueValidation.data
    });
  } catch (readError) {
    return {
      ...pathsWithExistence,
      error: new PentestError(
        `Failed to read queue file for ${pathsWithExistence.vulnType}: ${readError.message}`,
        'filesystem',
        false,
        {
          vulnType: pathsWithExistence.vulnType,
          queuePath: pathsWithExistence.queue,
          originalError: readError.message
        }
      )
    };
  }
};

// Pure function to determine exploitation decision
/**
 * [목적] 취약점 존재 여부 기반 exploit 실행 결정.
 *
 * [호출자]
 * - validateQueueAndDeliverable()
 */
const determineExploitationDecision = (validatedData) => {
  if (validatedData.error) {
    throw validatedData.error;
  }

  const hasVulnerabilities = validatedData.queueData.vulnerabilities.length > 0;

  // Rule 4: Both exist, queue valid and populated
  // Rule 5: Both exist, queue valid but empty
  return Object.freeze({
    shouldExploit: hasVulnerabilities,
    shouldRetry: false,
    vulnerabilityCount: validatedData.queueData.vulnerabilities.length,
    vulnType: validatedData.vulnType
  });
};

// Main functional validation pipeline
/**
 * [목적] 큐/리포트 검증 파이프라인 실행.
 *
 * [호출자]
 * - exploit 단계, validator 등
 */
export const validateQueueAndDeliverable = async (vulnType, sourceDir) =>
  await pipe(
    () => createPaths(vulnType, sourceDir),
    checkFileExistence,
    validateExistenceRules,
    validateQueueContent,
    determineExploitationDecision
  )();

// Pure function to safely validate (returns result instead of throwing)
/**
 * [목적] 예외 없이 검증 결과를 반환하는 안전 래퍼.
 *
 * [호출자]
 * - 병렬 실행/상태 표시 로직
 */
export const safeValidateQueueAndDeliverable = async (vulnType, sourceDir) => {
  try {
    const result = await validateQueueAndDeliverable(vulnType, sourceDir);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error };
  }
};
