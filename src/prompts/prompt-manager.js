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

    let result = template
      .replace(/{{WEB_URL}}/g, variables.webUrl)
      .replace(/{{REPO_PATH}}/g, path.relative(process.cwd(), variables.repoPath) || '.')
      .replace(/{{MCP_SERVER}}/g, variables.MCP_SERVER || 'playwright-agent1')
      .replace(/{{VULNERABILITY_DATA}}/g, variables.vulnerabilityData || '[]')
      .replace(/{{XSS_TEST}}/g, 'DOKODEMO_XSS_MARKER');

    if (config) {
      // Prepare rules text
      const avoidRules = (config.avoid && config.avoid.length > 0)
        ? config.avoid.map(r => `- ${r.description}`).join('\n')
        : 'None';
      const focusRules = (config.focus && config.focus.length > 0)
        ? config.focus.map(r => `- ${r.description}`).join('\n')
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

      // Inject application profile context
      let profileText = '';
      if (config.profile) {
        const sections = [
          { key: 'application_overview', title: 'Application Overview' },
          { key: 'technology_stack', title: 'Technology Stack' },
          { key: 'authentication_architecture', title: 'Authentication Architecture' },
          { key: 'api_endpoints', title: 'API Endpoints & Targets' },
          { key: 'business_logic', title: 'Business Logic & Workflows' },
          { key: 'data_flow', title: 'Data Flow & Persistence' },
          { key: 'security_controls', title: 'Existing Security Controls' },
          { key: 'known_vulnerabilities', title: 'Known Vulnerabilities (to verify)' },
          { key: 'custom_notes', title: 'Custom Testing Notes' }
        ];

        profileText = sections
          .filter(s => config.profile[s.key])
          .map(s => `### ${s.title}\n${config.profile[s.key]}`)
          .join('\n\n');
      }
      result = result.replace(/{{APP_PROFILE}}/g, profileText || 'No detailed application profile provided.');
    } else {
      // Fallback for missing config
      const cleanRulesSection = '<rules>\nNo specific rules or focus areas provided for this test.\n</rules>';
      result = result.replace(/<rules>[\s\S]*?<\/rules>/g, cleanRulesSection);
      result = result
        .replace(/{{RULES_AVOID}}/g, 'None')
        .replace(/{{RULES_FOCUS}}/g, 'None')
        .replace(/{{LOGIN_INSTRUCTIONS}}/g, '')
        .replace(/{{LOGIN_URL}}/g, `${variables.webUrl}/login`)
        .replace(/{{APP_PROFILE}}/g, 'No detailed application profile provided.');
    }

    // Validate that all placeholders have been replaced (excluding instructional text and SSTI-style examples)
    const remainingPlaceholders = result.match(/\{\{[^}]+\}\}/g);
    if (remainingPlaceholders) {
      const actualPlaceholders = remainingPlaceholders.filter(p => {
        // Ignore math/expression examples like {{7*7}} or {{ user_input }}
        if (p.includes('*') || p.includes('user_input')) return false;
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
