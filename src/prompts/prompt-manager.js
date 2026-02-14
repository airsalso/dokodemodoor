import { fs, path } from 'zx';
import chalk from 'chalk';
import { PentestError, handlePromptError } from '../error-handling.js';
import { MCP_AGENT_MAPPING } from '../constants.js';

// Pure function: Build complete login instructions from config
/**
 * [목적] 인증 설정을 기반으로 로그인 지침 텍스트를 생성.
 *
 * [호출자]
 * - interpolateVariables()에서 {{LOGIN_INSTRUCTIONS}} 치환
 *
 * [출력 대상]
 * - 로그인 지침 문자열 반환
 *
 * [입력 파라미터]
 * - authentication (object)
 * - baseDir (string)
 *
 * [반환값]
 * - Promise<string>
 *
 * [에러 처리]
 * - 템플릿 누락/파싱 오류 시 PentestError 발생
 */
async function buildLoginInstructions(authentication, baseDir = 'prompts-openai') {
  try {
    // Load the login instructions template
    const loginInstructionsPath = path.join(import.meta.dirname, '..', '..', baseDir, 'shared', 'login-instructions.txt');

    if (!await fs.pathExists(loginInstructionsPath)) {
      throw new PentestError(
        'Login instructions template not found',
        'filesystem',
        false,
        { loginInstructionsPath }
      );
    }

    const fullTemplate = await fs.readFile(loginInstructionsPath, 'utf8');

    // Helper function to extract sections based on markers
    const getSection = (content, sectionName) => {
      const regex = new RegExp(`<!-- BEGIN:${sectionName} -->([\\s\\S]*?)<!-- END:${sectionName} -->`, 'g');
      const match = regex.exec(content);
      return match ? match[1].trim() : '';
    };

    // Extract sections based on login type
    const loginType = authentication.login_type?.toUpperCase();
    let loginInstructions = '';

    // Build instructions with only relevant sections
    const commonSection = getSection(fullTemplate, 'COMMON');
    const authSection = getSection(fullTemplate, loginType); // FORM or SSO
    const verificationSection = getSection(fullTemplate, 'VERIFICATION');

    // Fallback to full template if markers are missing (backward compatibility)
    if (!commonSection && !authSection && !verificationSection) {
      console.log(chalk.yellow('⚠️ Section markers not found, using full login instructions template'));
      loginInstructions = fullTemplate;
    } else {
      // Combine relevant sections
      loginInstructions = [commonSection, authSection, verificationSection]
        .filter(section => section) // Remove empty sections
        .join('\n\n');
    }

    // Replace the user instructions placeholder with the login flow from config
    let userInstructions = authentication.login_flow.join('\n');

    // Replace credential placeholders within the user instructions
    if (authentication.credentials) {
      if (authentication.credentials.username) {
        userInstructions = userInstructions.replace(/\$username/g, authentication.credentials.username);
      }
      if (authentication.credentials.password) {
        userInstructions = userInstructions.replace(/\$password/g, authentication.credentials.password);
      }
      if (authentication.credentials.totp_secret) {
        userInstructions = userInstructions.replace(/\$totp/g, `generated TOTP code using secret "${authentication.credentials.totp_secret}"`);
      } else if (authentication.credentials.totp_code) {
        userInstructions = userInstructions.replace(/\$totp/g, authentication.credentials.totp_code);
      }
    }

    loginInstructions = loginInstructions.replace(/{{user_instructions}}/g, userInstructions);

    // Replace TOTP secret placeholder if present in template
    if (authentication.credentials?.totp_secret) {
      loginInstructions = loginInstructions.replace(/{{totp_secret}}/g, authentication.credentials.totp_secret);
    } else {
      loginInstructions = loginInstructions.replace(/{{totp_secret}}/g, '');
    }

    return loginInstructions;
  } catch (error) {
    if (error instanceof PentestError) {
      throw error;
    }
    throw new PentestError(
      `Failed to build login instructions: ${error.message}`,
      'config',
      false,
      { authentication, originalError: error.message }
    );
  }
}

// Pure function: Process @include() directives
/**
 * [목적] 프롬프트 템플릿의 @include() 지시어를 실제 파일로 치환.
 *
 * [호출자]
 * - loadPrompt()에서 프롬프트 로딩 시
 *
 * [출력 대상]
 * - include가 적용된 템플릿 문자열 반환
 *
 * [입력 파라미터]
 * - content (string)
 * - baseDir (string)
 *
 * [반환값]
 * - Promise<string>
 */
async function processIncludes(content, baseDir) {
  const includeRegex = /@include\(([^)]+)\)/g;
  // Use a Promise.all to handle all includes concurrently
  const replacements = await Promise.all(
    Array.from(content.matchAll(includeRegex)).map(async (match) => {
      const includePath = path.join(baseDir, match[1]);
      const sharedContent = await fs.readFile(includePath, 'utf8');
      return {
        placeholder: match[0],
        content: sharedContent,
      };
    })
  );

  for (const replacement of replacements) {
    content = content.replace(replacement.placeholder, replacement.content);
  }
  return content;
}

// Pure function: Collect security context from deliverables
/**
 * [목적] deliverables 폴더의 OSV 및 Semgrep 결과물을 수집하여 프롬프트에 제공.
 */
function summarizeSemgrep(content, maxFindings = 20) {
  const lines = content.split('\n');
  const findings = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('### [')) {
      const title = line.replace('### ', '').trim();
      const severity = title.includes('(ERROR)') ? 'ERROR'
        : title.includes('(WARNING)') ? 'WARNING'
          : title.includes('(INFO)') ? 'INFO'
            : 'OTHER';
      let desc = '';
      let files = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l.startsWith('### [')) break;
        if (l.startsWith('**Description:**')) {
          desc = l.replace('**Description:**', '').trim();
        }
        if (l.startsWith('| `') || l.startsWith('| `') || l.includes('`') && l.includes('|')) {
          // capture file rows from markdown tables
          if (l.includes('`')) files.push(l.trim());
        }
      }
      findings.push({ title, severity, desc, files: files.slice(0, 3), order: findings.length });
      i = j;
      if (findings.length >= maxFindings) break;
      continue;
    }
    i++;
  }
  if (findings.length === 0) return content.length > 1200 ? content.slice(0, 1200) + '... (truncated)' : content;
  const severityRank = { ERROR: 3, WARNING: 2, INFO: 1, OTHER: 0 };
  const ordered = [...findings].sort((a, b) => {
    const diff = (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0);
    return diff !== 0 ? diff : a.order - b.order;
  }).slice(0, maxFindings);
  const summary = ordered.map(f => {
    const fileLines = f.files.length ? `\n  Files:\n  ${f.files.join('\n  ')}` : '';
    return `- ${f.title}\n  Desc: ${f.desc || 'N/A'}${fileLines}`;
  }).join('\n');
  return `Top Semgrep Findings (summarized):\n${summary}`;
}

async function collectSecurityContext(repoPath) {
  try {
    const securityContext = [];
    const deliverablesDir = path.join(repoPath, 'deliverables');

    if (!await fs.pathExists(deliverablesDir)) return '';

    const securityFiles = [
      { name: 'osv_analysis_deliverable.md', title: 'Open Source Vulnerabilities' },
      { name: 'semgrep_analysis_deliverable.md', title: 'Static Analysis Hotspots' }
    ];

    for (const file of securityFiles) {
      const filePath = path.join(deliverablesDir, file.name);
      if (await fs.pathExists(filePath)) {
        const content = await fs.readFile(filePath, 'utf8');
        let rendered = content;
        if (file.name === 'semgrep_analysis_deliverable.md') {
          rendered = summarizeSemgrep(content, 20);
        }
        const maxLen = 5000;
        const truncated = rendered.length > maxLen ? rendered.slice(0, maxLen) + '... (truncated)' : rendered;
        securityContext.push(`### ${file.title}\n${truncated}`);
      }
    }

    if (securityContext.length === 0) return '';

    return `
## 🛡️ SECURITY LANDSCAPE CONTEXT (PRE-CALCULATED)
The following information was gathered by automated security tools.
Use this as a REASONING FOUNDATION, but do not satisfy yourself with only these findings.
Your mission is to find logical flaws and complex vulnerabilities that these tools miss.

${securityContext.join('\n\n---\n\n')}
`.trim();
  } catch (err) {
    return ''; // Fail silently for security context
  }
}

// Pure function: Variable interpolation
/**
 * [목적] 프롬프트 템플릿 변수들을 실제 값으로 치환.
 *
 * [호출자]
 * - loadPrompt() → processIncludes() 이후
 *
 * [출력 대상]
 * - 치환된 최종 프롬프트 문자열 반환
 *
 * [입력 파라미터]
 * - template (string)
 * - variables (object)
 * - config (object|null)
 * - baseDir (string)
 *
 * [반환값]
 * - Promise<string>
 *
 * [에러 처리]
 * - 필수 변수 누락 시 PentestError 발생
 */
async function interpolateVariables(template, variables, config = null, baseDir = 'prompts') {
  try {
    if (!template || typeof template !== 'string') {
      throw new PentestError(
        'Template must be a non-empty string',
        'validation',
        false,
        { templateType: typeof template, templateLength: template?.length }
      );
    }

    if (!variables || !variables.webUrl || !variables.repoPath) {
      throw new PentestError(
        'Variables must include webUrl and repoPath',
        'validation',
        false,
        { variables: Object.keys(variables || {}) }
      );
    }

    const securityContext = await collectSecurityContext(variables.repoPath);

    let result = template
      .replace(/{{WEB_URL}}/g, variables.webUrl)
      .replace(/{{REPO_PATH}}/g, variables.repoPath)
      .replace(/{{MCP_SERVER}}/g, variables.MCP_SERVER || 'playwright-agent1')
      .replace(/{{VULNERABILITY_DATA}}/g, variables.vulnerabilityData || '[]')
      .replace(/{{VULNERABILITY_COUNT}}/g, variables.vulnerabilityCount || '0')
      .replace(/{{QUEUE_SUMMARY}}/g, variables.queueSummary || 'No queue summary available.')
      .replace(/{{SECURITY_CONTEXT}}/g, securityContext)
      .replace(/{{CUMULATIVE_CONTEXT}}/g, variables.CUMULATIVE_CONTEXT || variables.cumulativeContext || '')
      .replace(/{{EXTERNAL_TEST_DOMAIN}}/g, config?.dokodemodoor?.externalTestDomain || process.env.EXTERNAL_TEST_DOMAIN || 'http://attacker-controlled.com')
      .replace(/{{VLLM_MAX_TURNS}}/g, config?.llm?.vllm?.maxTurns || process.env.VLLM_MAX_TURNS || '100')
      .replace(/{{XSS_TEST}}/g, 'DOKODEMO_XSS_MARKER')
      .replace(/{{FILE_OPEN_CAP}}/g, variables.FILE_OPEN_CAP != null ? String(variables.FILE_OPEN_CAP) : '—')
      .replace(/{{SEARCH_CAP}}/g, variables.SEARCH_CAP != null ? String(variables.SEARCH_CAP) : '—')
      // Reverse Engineering variables
      .replace(/{{BINARY_PATH}}/g, variables.binaryPath || '')
      .replace(/{{SYMBOLS_PATH}}/g, variables.symbolsPath || '')
      .replace(/{{PROCESS_NAME}}/g, variables.processName || '')
      .replace(/{{ANALYSIS_FOCUS}}/g, variables.analysisFocus || 'network, authentication, cryptography');

    if (config) {
      // Prepare rules text
      const formatRule = (rule) => {
        const details = [];
        if (rule.type) details.push(`type: ${rule.type}`);
        if (rule.url_path) details.push(`path: ${rule.url_path}`);
        const suffix = details.length ? ` (${details.join(', ')})` : '';
        return `- ${rule.description}${suffix}`;
      };

      const avoidRules = (config.avoid && config.avoid.length > 0)
        ? config.avoid.map(formatRule).join('\n')
        : 'None';
      const focusRules = (config.focus && config.focus.length > 0)
        ? config.focus.map(formatRule).join('\n')
        : 'None';

      // Always replace placeholders regardless of rules existence
      result = result
        .replace(/{{RULES_AVOID}}/g, avoidRules)
        .replace(/{{RULES_FOCUS}}/g, focusRules);

      // Handle rules tag section for backward compatibility or explicit sections
      if (avoidRules === 'None' && focusRules === 'None') {
        const cleanRulesSection = '<rules>\nNo specific rules or focus areas provided for this test.\n</rules>';
        result = result.replace(/<rules>[\s\S]*?<\/rules>/g, cleanRulesSection);
      }

      // Extract and inject login instructions from config
      if (config.authentication?.login_flow) {
        const loginInstructions = await buildLoginInstructions(config.authentication, baseDir);
        result = result.replace(/{{LOGIN_INSTRUCTIONS}}/g, loginInstructions);
      } else {
        result = result.replace(/{{LOGIN_INSTRUCTIONS}}/g, '');
      }

      // Inject login URL
      const loginUrl = config.authentication?.login_url || `${variables.webUrl}/login`;
      result = result.replace(/{{LOGIN_URL}}/g, loginUrl);

      // Application profile is intentionally not supported.
    } else {
      // Fallback for missing config
      const cleanRulesSection = '<rules>\nNo specific rules or focus areas provided for this test.\n</rules>';
      result = result.replace(/<rules>[\s\S]*?<\/rules>/g, cleanRulesSection);
      result = result
        .replace(/{{RULES_AVOID}}/g, 'None')
        .replace(/{{RULES_FOCUS}}/g, 'None')
        .replace(/{{LOGIN_INSTRUCTIONS}}/g, '')
        .replace(/{{LOGIN_URL}}/g, `${variables.webUrl}/login`)
        ;
    }

    // Validate that all placeholders have been replaced (excluding instructional text and SSTI-style examples)
    const remainingPlaceholders = result.match(/\{\{[^}]+\}\}/g);
    if (remainingPlaceholders) {
      const actualPlaceholders = remainingPlaceholders.filter(p => {
        const pLower = p.toLowerCase();
        // Ignore math/expression examples, common SSTI payloads, or user input placeholders
        if (p.includes('*') ||
            pLower.includes('user_input') ||
            pLower.includes('user') || // XSS examples like {{user}} in <img src={{user}}>
            pLower.includes('expr') ||
            pLower.includes('config') ||
            pLower.includes('request') ||
            pLower.includes('self') ||
            pLower.includes('settings')) return false;
        return true;
      });

      if (actualPlaceholders.length > 0) {
        console.log(chalk.yellow(`⚠️ Warning: Found unresolved placeholders in prompt: ${actualPlaceholders.join(', ')}`));
      }
    }

    return result;
  } catch (error) {
    if (error instanceof PentestError) {
      throw error;
    }
    throw new PentestError(
      `Variable interpolation failed: ${error.message}`,
      'prompt',
      false,
      { originalError: error.message }
    );
  }
}

// Pure function: Load and interpolate prompt template
/**
 * [목적] 프롬프트 파일 로드 및 변수/인클루드 처리.
 *
 * [호출자]
 * - agent-executor, checkpoint-manager에서 에이전트 실행 시
 *
 * [출력 대상]
 * - 최종 프롬프트 문자열 반환
 *
 * [입력 파라미터]
 * - promptName (string)
 * - variables (object)
 * - config (object|null)
 *
 * [반환값]
 * - Promise<string>
 */
export async function loadPrompt(promptName, variables, config = null) {
  try {
    const baseDir = 'prompts-openai';
    console.log(chalk.blue(`    🤖 Using OpenAI-compatible prompt for vLLM`));

    const promptsDir = path.join(import.meta.dirname, '..', '..', baseDir);
    const promptPath = path.join(promptsDir, `${promptName}.txt`);

    // Check if file exists first
    if (!await fs.pathExists(promptPath)) {
      throw new PentestError(
        `Prompt file not found: ${promptPath}`,
        'prompt',
        false,
        { promptName, promptPath, provider: 'vllm' }
      );
    }

    // Add MCP server assignment to variables
    const enhancedVariables = { ...variables };

    // Assign MCP server based on prompt name (agent name)
    if (MCP_AGENT_MAPPING[promptName]) {
      enhancedVariables.MCP_SERVER = MCP_AGENT_MAPPING[promptName];
      console.log(chalk.gray(`    🎭 Assigned ${promptName} → ${enhancedVariables.MCP_SERVER}`));
    } else {
      // Fallback for unknown agents
      enhancedVariables.MCP_SERVER = 'playwright-agent1';
      console.log(chalk.yellow(`    🎭 Unknown agent ${promptName}, using fallback → ${enhancedVariables.MCP_SERVER}`));
    }

    let template = await fs.readFile(promptPath, 'utf8');

    // Pre-process the template to handle @include directives
    template = await processIncludes(template, promptsDir);

    return await interpolateVariables(template, enhancedVariables, config, baseDir);
  } catch (error) {
    if (error instanceof PentestError) {
      throw error;
    }
    const promptError = handlePromptError(promptName, error);
    throw promptError.error;
  }
}
