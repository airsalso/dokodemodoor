import { path, fs } from 'zx';
import chalk from 'chalk';
import { validateQueueAndDeliverable } from './queue-validation.js';

// Factory function for vulnerability queue validators
/**
 * [목적] 취약점 큐/리포트 검증 함수 팩토리.
 *
 * [호출자]
 * - AGENT_VALIDATORS
 */
function createVulnValidator(vulnType) {
  return async (sourceDir) => {
    try {
      await validateQueueAndDeliverable(vulnType, sourceDir);
      return true;
    } catch (error) {
      console.log(chalk.yellow(`   Queue validation failed for ${vulnType}: ${error.message}`));
      return false;
    }
  };
}

// Factory function for exploit deliverable validators
/**
 * [목적] 익스플로잇 증거 파일 존재 여부 검증 함수 팩토리.
 *
 * [호출자]
 * - AGENT_VALIDATORS
 */
function createExploitValidator(vulnType) {
  return async (sourceDir) => {
    const evidenceFile = path.join(sourceDir, 'deliverables', `${vulnType}_exploitation_evidence.json`);
    return await fs.pathExists(evidenceFile);
  };
}

/**
 * Phase-based tool requirements
 * Defines which phases need Playwright to optimize resource usage
 *
 * @type {Object.<string, {playwright: boolean}>}
 */
export const PHASE_TOOL_REQUIREMENTS = Object.freeze({
  'pre-reconnaissance': {
    playwright: false  // Pure static analysis, no browser needed
  },
  'reconnaissance': {
    playwright: true   // Runtime analysis, API discovery, auth flow
  },
  'api-fuzzing': {
    playwright: false  // CLI-based tools like Schemathesis
  },
  'vulnerability-analysis': {

    playwright: true   // XSS execution, CSRF token extraction, auth state
  },
  'exploitation': {
    playwright: true   // Multi-step attacks, result verification
  },
  'reporting': {
    playwright: false  // Document writing only
  },
  'osv-analysis': {
    playwright: false  // Source code and API analysis, no browser needed
  },
  // Reverse Engineering phases (no browser needed)
  're-inventory': { playwright: false },
  're-static-analysis': { playwright: false },
  're-dynamic-observation': { playwright: false },
  're-network-analysis': { playwright: false },
  're-reporting': { playwright: false }
});

/**
 * Agent-specific tool overrides
 * Allows fine-grained control for specific agents that deviate from phase defaults
 *
 * @type {Object.<string, {playwright: boolean}>}
 */
export const AGENT_TOOL_OVERRIDES = Object.freeze({
  'recon-verify': {
    playwright: false  // Primarily code verification, not runtime testing
  },
  'login-check': {
    playwright: true   // Pre-flight login verification requires browser
  }
});

// MCP agent mapping - assigns each agent to a specific Playwright instance to prevent conflicts
// Only agents that actually need Playwright should be listed here
export const MCP_AGENT_MAPPING = Object.freeze({
  // Phase 1: Pre-reconnaissance
  'pre-recon-code': 'dokodemodoor-helper', // Static analysis only; avoid Playwright fallback

  // Phase 2: Reconnaissance
  'recon': 'playwright-agent2',
  // recon-verify doesn't need Playwright; map to local MCP for prompt interpolation
  'recon-verify': 'dokodemodoor-helper',
  // Pre-flight login verification
  'login-check': 'playwright-agent2',

  // Phase 3: API Fuzzing (Non-browser)
  'api-fuzzer': 'api-fuzzer-agent',

  // Phase 4: Vulnerability Analysis (Parallel agents)
  'vuln-sqli': 'playwright-agent1',
  'vuln-codei': 'playwright-agent1',
  'vuln-ssti': 'playwright-agent1',
  'vuln-pathi': 'playwright-agent1',
  'vuln-xss': 'playwright-agent2',
  'vuln-auth': 'playwright-agent3',
  'vuln-ssrf': 'playwright-agent4',
  'vuln-authz': 'playwright-agent5',

  // Phase 4: Exploitation (Parallel agents)
  'exploit-sqli': 'playwright-agent1',
  'exploit-codei': 'playwright-agent1',
  'exploit-ssti': 'playwright-agent1',
  'exploit-pathi': 'playwright-agent1',
  'exploit-xss': 'playwright-agent2',
  'exploit-auth': 'playwright-agent3',
  'exploit-ssrf': 'playwright-agent4',
  'exploit-authz': 'playwright-agent5',

  // Phase 5: Reporting
  // REMOVED: report doesn't need Playwright (document writing only)

  // OSV Analysis agent
  'osv-analysis': 'dokodemodoor-helper',

  // Reverse Engineering agents
  're-inventory': 're-sigcheck',
  're-static': 're-ghidra',
  're-dynamic': 're-procmon',
  're-instrument': 're-frida',
  're-network': 're-tshark',
  're-report': 'dokodemodoor-helper'
});

// Direct agent-to-validator mapping - much simpler than pattern matching
export const AGENT_VALIDATORS = Object.freeze({
  // Pre-reconnaissance agent - validates the code analysis deliverable created by the agent
  'pre-recon': async (sourceDir) => {
    const codeAnalysisFile = path.join(sourceDir, 'deliverables', 'code_analysis_deliverable.md');
    const preReconFile = path.join(sourceDir, 'deliverables', 'pre_recon_deliverable.md');

    const codeExists = await fs.pathExists(codeAnalysisFile);
    const preReconExists = await fs.pathExists(preReconFile);

    if (!codeExists && !preReconExists) {
      console.log(chalk.red(`    ❌ Missing required deliverable: code_analysis_deliverable.md or pre_recon_deliverable.md`));
      return false;
    }
    return true;
  },

  // Reconnaissance agent
  'recon': async (sourceDir) => {
    const reconFile = path.join(sourceDir, 'deliverables', 'recon_deliverable.md');
    return await fs.pathExists(reconFile);
  },
  'recon-verify': async (sourceDir) => {
    const reconFile = path.join(sourceDir, 'deliverables', 'recon_deliverable.md');
    const reconVerifyFile = path.join(sourceDir, 'deliverables', 'recon_verify_deliverable.md');
    if (!(await fs.pathExists(reconFile))) return false;
    if (!(await fs.pathExists(reconVerifyFile))) return false;
    const content = await fs.readFile(reconVerifyFile, 'utf8');
    const lowerContent = content.toLowerCase();
    return lowerContent.includes('recon verify') || lowerContent.includes('recon verification');
  },
  'api-fuzzer': async (sourceDir) => {
    const deliverablesDir = path.join(sourceDir, 'deliverables');
    const reconFile = path.join(deliverablesDir, 'recon_deliverable.md');
    const apiFuzzFile = path.join(deliverablesDir, 'api_fuzzer_deliverable.md');

    const reconExists = await fs.pathExists(reconFile);
    const apiFuzzExists = await fs.pathExists(apiFuzzFile);

    if (!reconExists) {
      console.log(chalk.red(`    ❌ Missing required deliverable: recon_deliverable.md (Master Recon Map)`));
      return false;
    }
    if (!apiFuzzExists) {
      console.log(chalk.red(`    ❌ Missing required deliverable: api_fuzzer_deliverable.md (Fuzzing Working Memory)`));
      console.log(chalk.yellow(`    💡 Hint: Ensure the agent saves with deliverable_type: "API_FUZZ_REPORT"`));
      return false;
    }

    return true;
  },

  // Vulnerability analysis agents
  'sqli-vuln': createVulnValidator('sqli'),
  'codei-vuln': createVulnValidator('codei'),
  'ssti-vuln': createVulnValidator('ssti'),
  'pathi-vuln': createVulnValidator('pathi'),
  'xss-vuln': createVulnValidator('xss'),
  'auth-vuln': createVulnValidator('auth'),
  'ssrf-vuln': createVulnValidator('ssrf'),
  'authz-vuln': createVulnValidator('authz'),

  // Exploitation agents
  'sqli-exploit': createExploitValidator('sqli'),
  'codei-exploit': createExploitValidator('codei'),
  'ssti-exploit': createExploitValidator('ssti'),
  'pathi-exploit': createExploitValidator('pathi'),
  'xss-exploit': createExploitValidator('xss'),
  'auth-exploit': createExploitValidator('auth'),
  'ssrf-exploit': createExploitValidator('ssrf'),
  'authz-exploit': createExploitValidator('authz'),

  // Executive report agent
  'report': async (sourceDir) => {
    const reportFile = path.join(sourceDir, 'deliverables', 'comprehensive_security_assessment_report.md');

    const reportExists = await fs.pathExists(reportFile);

    if (!reportExists) {
      console.log(chalk.red(`    ❌ Missing required deliverable: comprehensive_security_assessment_report.md`));
    }

    return reportExists;
  },

  // Login verification agent - validates that the agent actually reported LOGIN_SUCCESS
  'login-check': async (sourceDir, sessionDir) => {
    if (!sessionDir) return true; // Fallback if sessionDir not provided
    const agentsDir = path.join(sessionDir, 'agents');
    if (!(await fs.pathExists(agentsDir))) return true;

    const files = await fs.readdir(agentsDir);
    const loginLogs = files.filter(f => f.includes('login-check') && f.endsWith('.debug.log'));
    if (loginLogs.length === 0) return true;

    // Get the latest log
    const latestLog = loginLogs.sort().reverse()[0];
    const content = await fs.readFile(path.join(agentsDir, latestLog), 'utf8');

    if (content.includes('LOGIN_SUCCESS')) return true;

    process.env.DEBUG_LOGIN ? console.log(chalk.red(`    ❌ Login check failed (LOGIN_SUCCESS not found in logs)`)) : null;
    return false;
  },

  // OSV Analysis agent
  'osv-analysis': async (sourceDir) => {
    const osvFile = path.join(sourceDir, 'deliverables', 'osv_analysis_deliverable.md');
    const queueFile = path.join(sourceDir, 'deliverables', 'osv_exploitation_queue.json');

    const osvExists = await fs.pathExists(osvFile);
    const queueExists = await fs.pathExists(queueFile);

    if (!osvExists || !queueExists) {
      console.log(chalk.red(`    ❌ Missing required deliverable: ${!osvExists ? 'osv_analysis_deliverable.md' : 'osv_exploitation_queue.json'}`));
      return false;
    }
    return true;
  },

  // Reverse Engineering agents
  're-inventory': async (sourceDir) => {
    const f = path.join(sourceDir, 'deliverables', 're_inventory_deliverable.md');
    return await fs.pathExists(f);
  },
  're-static': async (sourceDir) => {
    const analysis = path.join(sourceDir, 'deliverables', 're_static_analysis_deliverable.md');
    const candidates = path.join(sourceDir, 'deliverables', 're_observation_candidates.json');
    return (await fs.pathExists(analysis)) && (await fs.pathExists(candidates));
  },
  're-dynamic': async (sourceDir) => {
    const f = path.join(sourceDir, 'deliverables', 're_dynamic_observation_deliverable.md');
    return await fs.pathExists(f);
  },
  're-instrument': async (sourceDir) => {
    const f = path.join(sourceDir, 'deliverables', 're_instrumentation_deliverable.md');
    return await fs.pathExists(f);
  },
  're-network': async (sourceDir) => {
    const f = path.join(sourceDir, 'deliverables', 're_network_analysis_deliverable.md');
    return await fs.pathExists(f);
  },
  're-report': async (sourceDir) => {
    const f = path.join(sourceDir, 'deliverables', 're_comprehensive_report.md');
    return await fs.pathExists(f);
  }
});
