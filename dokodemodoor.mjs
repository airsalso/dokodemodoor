#!/usr/bin/env node
import { path, fs, $ } from 'zx';
import chalk from 'chalk';
import dotenv from 'dotenv';

dotenv.config();

// Config and Tools
import { loadConfig } from './src/config/config-loader.js';
import { checkToolAvailability, handleMissingTools } from './src/tool-checker.js';

// Session and Checkpoints
import { createSession, updateSession, getSession, AGENTS, getPhaseIndexForAgent, checkPrerequisites, markAgentSkipped } from './src/session-manager.js';
import { runPhase, getGitCommitHash } from './src/checkpoint-manager.js';

// Setup and Deliverables
import { setupLocalRepo } from './src/setup/environment.js';

// AI and Prompts
import { runAgentPromptWithRetry } from './src/ai/agent-executor.js';
import { loadPrompt } from './src/prompts/prompt-manager.js';

// Phases
import { executePreReconPhase } from './src/phases/pre-recon.js';
import { assembleFinalReport } from './src/phases/reporting.js';

// Utils
import { timingResults, costResults, displayTimingSummary, Timer } from './src/utils/metrics.js';
import { formatDuration, generateAuditPath, ensureDirectory } from './src/audit/utils.js';

// CLI
import { handleDeveloperCommand } from './src/cli/command-handler.js';
import { showHelp, displaySplashScreen } from './src/cli/ui.js';
import { validateWebUrl, validateRepoPath } from './src/cli/input-validator.js';
import { parseCliArgs } from './src/cli/args.js';

// Error Handling
import { PentestError, logError } from './src/error-handling.js';

// Session Manager Functions
import {
  calculateVulnerabilityAnalysisSummary,
  calculateExploitationSummary,
  getNextAgent
} from './src/session-manager.js';

// Configure zx to disable timeouts (let tools run as long as needed)
$.timeout = 0;

// Track active session globally for signal handlers
let activeSessionId = null;

// Setup graceful cleanup on process signals
/**
 * [목적] SIGINT 처리 및 정상 종료.
 *
 * [호출자]
 * - Node 프로세스 시그널 핸들러
 *
 * [출력 대상]
 * - 종료 메시지 출력 후 프로세스 종료
 *
 * [부작용]
 * - 프로세스 종료
 */
process.on('SIGINT', async () => {
  console.log(chalk.yellow('\n⚠️ Received SIGINT, cleaning up...'));

  if (activeSessionId) {
    try {
      // Mark session as interrupted if it was active
      await updateSession(activeSessionId, { status: 'interrupted', lastActivity: getLocalISOString() });
      console.log(chalk.gray(`    📝 Session ${activeSessionId.substring(0, 8)} marked as interrupted`));
    } catch (e) {
      // Ignore errors during exit cleanup
    }
  }

  process.exit(0);
});

/**
 * [목적] SIGTERM 처리 및 정상 종료.
 *
 * [호출자]
 * - Node 프로세스 시그널 핸들러
 *
 * [출력 대상]
 * - 종료 메시지 출력 후 프로세스 종료
 *
 * [부작용]
 * - 프로세스 종료
 */
process.on('SIGTERM', async () => {
  console.log(chalk.yellow('\n⚠️ Received SIGTERM, cleaning up...'));

  if (activeSessionId) {
    try {
      await updateSession(activeSessionId, { status: 'interrupted', lastActivity: getLocalISOString() });
    } catch (e) {
      // Ignore
    }
  }

  process.exit(0);
});

/**
 * [목적] 예기치 않은 에러 처리 및 세션 상태 업데이트.
 */
process.on('uncaughtException', async (error) => {
  console.log(chalk.red('\n🔥 Uncaught Exception!'));
  console.error(error);

  if (activeSessionId) {
    try {
      await updateSession(activeSessionId, { status: 'failed', lastActivity: getLocalISOString() });
      console.log(chalk.gray(`    📝 Session ${activeSessionId.substring(0, 8)} marked as failed`));
    } catch (e) {}
  }

  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  console.log(chalk.red('\n🔥 Unhandled Rejection at:'), promise, 'reason:', reason);

  if (activeSessionId) {
    try {
      await updateSession(activeSessionId, { status: 'failed', lastActivity: getLocalISOString() });
    } catch (e) {}
  }

  process.exit(1);
});


// Main orchestration function
/**
 * [목적] CLI 진입점에서 전체 펜테스트 파이프라인 오케스트레이션.
 *
 * [호출자]
 * - 이 파일 하단의 CLI 인자 처리
 *
 * [출력 대상]
 * - 단계/에이전트 실행, deliverables/audit/session 저장
 *
 * [입력 파라미터]
 * - webUrl (string)
 * - repoPath (string)
 * - configPath (string|null)
 * - disableLoader (boolean)
 *
 * [반환값]
 * - Promise<void>
 *
 * [부작용]
 * - 파일 I/O, git 작업, 네트워크 호출, 콘솔 출력
 */
async function main(webUrl, repoPath, configPath = null, disableLoader = false) {
  // Set global flag for loader control
  global.DOKODEMODOOR_DISABLE_LOADER = disableLoader;

  // Debug: Show loader status
  if (disableLoader) {
    console.log(chalk.gray('🔧 Loader disabled - full output mode enabled'));
  }

  const totalTimer = new Timer('total-execution');
  timingResults.total = totalTimer;

  // Display splash screen
  await displaySplashScreen();

  console.log(chalk.cyan.bold('🚀 AI Based DokodemoDoor AGENT - for Pentest'));
  console.log(chalk.cyan(`🎯 Target: ${webUrl}`));
  console.log(chalk.cyan(`📁 Source: ${repoPath}`));
  if (configPath) {
    console.log(chalk.cyan(`⚙️ Config: ${configPath}`));
  }
  console.log(chalk.gray('─'.repeat(60)));

  // Parse configuration if provided
  let distributedConfig = null;
  if (configPath) {
    try {
      const configResult = await loadConfig(configPath);
      distributedConfig = configResult.distributedConfig;
      console.log(chalk.green(`✅ Configuration loaded successfully`));
    } catch (error) {
      await logError(error, `Configuration loading from ${configPath}`);
      throw error; // Let the main error boundary handle it
    }
  }

  // Check tool availability
  const toolAvailability = await checkToolAvailability();
  handleMissingTools(toolAvailability);

  // Setup local repository
  console.log(chalk.blue('📁 Setting up local repository...'));
  let sourceDir;
  try {
    sourceDir = await setupLocalRepo(repoPath);
    console.log(chalk.green('✅ Local repository setup successfully'));
  } catch (error) {
    console.log(chalk.red(`❌ Failed to setup local repository: ${error.message}`));
    console.log(chalk.gray('This could be due to:'));
    console.log(chalk.gray('  - Insufficient permissions'));
    console.log(chalk.gray('  - Repository path not accessible'));
    console.log(chalk.gray('  - Git initialization issues'));
    console.log(chalk.gray('  - Insufficient disk space'));
    process.exit(1);
  }

  const variables = { webUrl, repoPath, sourceDir };

  // Create session for tracking (in normal mode)
  const session = await createSession(webUrl, repoPath, configPath, sourceDir);
  activeSessionId = session.id; // Set active session ID for global handlers
  console.log(chalk.blue(`📝 Session created: ${session.id.substring(0, 8)}...`));


  // Persist full console output to audit logs for debugging
  try {
    const auditPath = generateAuditPath({ id: session.id, webUrl });
    await ensureDirectory(auditPath);
    const consoleLogPath = path.join(auditPath, 'console.log');
    const consoleLogStream = fs.createWriteStream(consoleLogPath, { flags: 'a' });

    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);

    process.stdout.write = (chunk, encoding, callback) => {
      consoleLogStream.write(chunk);
      return origStdoutWrite(chunk, encoding, callback);
    };
    process.stderr.write = (chunk, encoding, callback) => {
      consoleLogStream.write(chunk);
      return origStderrWrite(chunk, encoding, callback);
    };

    console.log(chalk.gray(`🧾 Console log saved to ${consoleLogPath}`));
  } catch (error) {
    console.log(chalk.yellow(`⚠️  Failed to initialize console log file: ${error.message}`));
  }

  // If setup-only mode, exit after session creation
  if (process.argv.includes('--setup-only')) {
    console.log(chalk.green('✅ Setup complete! Local repository setup and session created.'));
    console.log(chalk.gray('Use developer commands to run individual agents:'));
    console.log(chalk.gray('  ./dokodemodoor.mjs --run-agent pre-recon'));
    console.log(chalk.gray('  ./dokodemodoor.mjs --status'));
    process.exit(0);
  }

  // Helper function to update session progress
  /**
   * [목적] 에이전트 완료 후 세션 상태 업데이트.
   *
   * [호출자]
   * - main() 각 에이전트 완료 시
   *
   * [출력 대상]
   * - updateSession()으로 세션 저장
   *
   * [입력 파라미터]
   * - agentName (string)
   * - commitHash (string|null)
   *
   * [반환값]
   * - Promise<void>
   */
  const updateSessionProgress = async (agentName, commitHash = null) => {
    try {
      const updates = {
        completedAgents: [...new Set([...session.completedAgents, agentName])],
        skippedAgents: (session.skippedAgents || []).filter(name => name !== agentName),
        failedAgents: session.failedAgents.filter(name => name !== agentName), // Remove from failed if it was there
        status: 'in-progress'
      };

      if (commitHash) {
        updates.checkpoints = { ...session.checkpoints, [agentName]: commitHash };
      }

      await updateSession(session.id, updates);
      // Update local session object for subsequent updates
      Object.assign(session, updates);
      console.log(chalk.gray(`    📝 Session updated: ${agentName} completed`));
    } catch (error) {
      console.log(chalk.yellow(`    ⚠️ Failed to update session: ${error.message}`));
    }
  };

  // Create outputs directory in source directory
  try {
    const outputsDir = path.join(sourceDir, 'outputs');
    await fs.ensureDir(outputsDir);
    await fs.ensureDir(path.join(outputsDir, 'schemas'));
    await fs.ensureDir(path.join(outputsDir, 'scans'));
  } catch (error) {
    throw new PentestError(
      `Failed to create output directories: ${error.message}`,
      'filesystem',
      false,
      { sourceDir, originalError: error.message }
    );
  }

  // Check if we should continue from where session left off
  const nextAgent = getNextAgent(session);
  if (!nextAgent) {
    console.log(chalk.green(`✅ All agents completed! Session is finished.`));
    await displayTimingSummary(timingResults, costResults, session.completedAgents);
    process.exit(0);
  }

  const completedCount = new Set([
    ...(session.completedAgents || []),
    ...(session.skippedAgents || [])
  ]).size;
  console.log(chalk.blue(`🔄 Continuing from ${nextAgent.displayName} (${completedCount}/${Object.keys(AGENTS).length} agents completed)`));

  // Determine which phase to start from based on next agent
  const startPhase = getPhaseIndexForAgent(nextAgent.name);

  // PHASE 1: PRE-RECONNAISSANCE
  if (startPhase <= 1) {
    const preReconTimer = new Timer('phase-1-pre-recon');
    await runPhase('pre-reconnaissance', session, runAgentPromptWithRetry, loadPrompt);
    const preReconDuration = preReconTimer.stop();
    timingResults.phases['pre-recon'] = preReconDuration;
  }

  // PHASE 2: RECONNAISSANCE
  if (startPhase <= 2) {
    console.log(chalk.magenta.bold('\n🔎 PHASE 2: RECONNAISSANCE'));
    const reconPhaseTimer = new Timer('phase-2-reconnaissance');

    await runPhase('reconnaissance', session, runAgentPromptWithRetry, loadPrompt);

    const reconPhaseDuration = reconPhaseTimer.stop();
    timingResults.phases['reconnaissance'] = reconPhaseDuration;
    console.log(chalk.green(`✅ Reconnaissance phase complete in ${formatDuration(reconPhaseDuration)}`));
  }

  // PHASE 3: API FUZZING
  if (startPhase <= 3) {
    console.log(chalk.cyan.bold('\n🔍 PHASE 3: API FUZZING (SCHEMATHESIS)'));
    const fuzzPhaseTimer = new Timer('phase-3-api-fuzzing');

    await runPhase('api-fuzzing', session, runAgentPromptWithRetry, loadPrompt);

    const fuzzPhaseDuration = fuzzPhaseTimer.stop();
    timingResults.phases['api-fuzzing'] = fuzzPhaseDuration;
    console.log(chalk.green(`✅ API fuzzing phase complete in ${formatDuration(fuzzPhaseDuration)}`));
  }

  // PHASE 4: VULNERABILITY ANALYSIS
  if (startPhase <= 4) {
    const vulnTimer = new Timer('phase-4-vulnerability-analysis');
    console.log(chalk.red.bold('\n🚨 PHASE 4: VULNERABILITY ANALYSIS'));

    await runPhase('vulnerability-analysis', session, runAgentPromptWithRetry, loadPrompt);

    // Display vulnerability analysis summary
    const currentSession = await getSession(session.id);
    const vulnSummary = calculateVulnerabilityAnalysisSummary(currentSession);
    console.log(chalk.blue(`\n📊 Vulnerability Analysis Summary: ${vulnSummary.totalAnalyses} analyses, ${vulnSummary.totalVulnerabilities} vulnerabilities found, ${vulnSummary.exploitationCandidates} ready for exploitation`));

    const vulnDuration = vulnTimer.stop();
    timingResults.phases['vulnerability-analysis'] = vulnDuration;

    console.log(chalk.green(`✅ Vulnerability analysis phase complete in ${formatDuration(vulnDuration)}`));
  }


  // PHASE 5: EXPLOITATION
  if (startPhase <= 5) {
    const exploitTimer = new Timer('phase-5-exploitation');
    console.log(chalk.red.bold('\n💥 PHASE 5: EXPLOITATION'));

    // Get fresh session data to ensure we have latest vulnerability analysis results
    const freshSession = await getSession(session.id);
    await runPhase('exploitation', freshSession, runAgentPromptWithRetry, loadPrompt);

    // Display exploitation summary
    const finalSession = await getSession(session.id);
    const exploitSummary = calculateExploitationSummary(finalSession);
    if (exploitSummary.eligibleExploits > 0) {
      console.log(chalk.blue(`\n🎯 Exploitation Summary: ${exploitSummary.totalAttempts}/${exploitSummary.eligibleExploits} attempted, ${exploitSummary.skippedExploits} skipped (no vulnerabilities)`));
    } else {
      console.log(chalk.gray(`\n🎯 Exploitation Summary: No exploitation attempts (no vulnerabilities found)`));
    }

    const exploitDuration = exploitTimer.stop();
    timingResults.phases['exploitation'] = exploitDuration;
  }


  // PHASE 6: REPORTING
  if (startPhase <= 6) {
    console.log(chalk.greenBright.bold('\n📊 PHASE 6: REPORTING'));
    console.log(chalk.greenBright('Generating executive summary and assembling final report...'));
    const reportTimer = new Timer('phase-6-reporting');

    await runPhase('reporting', session, runAgentPromptWithRetry, loadPrompt);

    const reportDuration = reportTimer.stop();
    timingResults.phases['reporting'] = reportDuration;

    console.log(chalk.green(`✅ Final report fully assembled in ${formatDuration(reportDuration)}`));
    console.log(chalk.cyan(`\n💡 To generate Korean translation, run: npm run translate-report`));
  }

  // PHASE 7: OSV ANALYSIS
  // You can enable/disable this via DOKODEMODOOR_SKIP_OSV_SCAN in .env (default: true)
  const isOsvEnabled = process.env.DOKODEMODOOR_SKIP_OSV_SCAN !== 'true';

  if (startPhase <= 7 && isOsvEnabled) {
    console.log(chalk.cyan.bold('\n🔍 PHASE 7: OPEN SOURCE VULNERABILITY ANALYSIS'));
    const osvTimer = new Timer('phase-7-osv-analysis');

    // Load OSV phase logic
    const { executeOsvAnalysisPhase } = await import('./src/phases/osv-analysis.js');
    await executeOsvAnalysisPhase(session, runAgentPromptWithRetry, loadPrompt);

    const osvDuration = osvTimer.stop();
    timingResults.phases['osv-analysis'] = osvDuration;
    console.log(chalk.green(`✅ OSV analysis phase complete in ${formatDuration(osvDuration)}`));
  }



  // Calculate final timing and cost data
  const totalDuration = timingResults.total.stop();
  const timingBreakdown = {
    total: totalDuration,
    phases: { ...timingResults.phases },
    agents: { ...timingResults.agents },
    commands: { ...timingResults.commands }
  };

  // Use accumulated cost data
  const costBreakdown = {
    total: costResults.total,
    agents: { ...costResults.agents }
  };

  // Mark session as completed with timing and cost data
  await updateSession(session.id, {
    status: 'completed',
    timingBreakdown,
    costBreakdown
  });
  activeSessionId = null; // Clear active session after successful completion


  // Display comprehensive timing summary
  displayTimingSummary();

  console.log(chalk.cyan.bold('\n🎉 PENETRATION TESTING COMPLETE!'));
  console.log(chalk.gray('─'.repeat(60)));

  // Calculate audit logs path
  const auditLogsPath = generateAuditPath(session);

  // Return final report path and audit logs path for clickable output
  return {
    reportPath: path.join(sourceDir, 'deliverables', 'comprehensive_security_assessment_report.md'),
    reportPathKr: path.join(sourceDir, 'deliverables', 'comprehensive_security_assessment_report_kr.md'),
    auditLogsPath
  };
}

// Entry point - handle both direct node execution and shebang execution
let args = process.argv.slice(2);
// If first arg is the script name (from shebang), remove it
if (args[0] && args[0].includes('dokodemodoor.mjs')) {
  args = args.slice(1);
}

const {
  configPath,
  sessionId,
  disableLoader,
  developerCommand,
  nonFlagArgs,
  showHelp: showHelpFlag,
  error: cliError
} = parseCliArgs(args, { defaultDisableLoader: process.env.DOKODEMODOOR_DISABLE_LOADER === 'true' });

if (cliError) {
  console.log(chalk.red(cliError));
  process.exit(1);
}

// Handle help flag
if (showHelpFlag) {
  showHelp();
  process.exit(0);
}

// Handle developer commands
if (developerCommand) {
  // Set global flag for loader control in developer mode too
  global.DOKODEMODOOR_DISABLE_LOADER = disableLoader;

  await handleDeveloperCommand(developerCommand, nonFlagArgs, runAgentPromptWithRetry, loadPrompt, sessionId);

  process.exit(0);
}

// Handle no arguments - show help
if (nonFlagArgs.length === 0) {
  console.log(chalk.red.bold('❌ Error: No arguments provided\n'));
  showHelp();
  process.exit(1);
}

// Handle insufficient arguments
if (nonFlagArgs.length < 2) {
  console.log(chalk.red('❌ Both WEB_URL and REPO_PATH are required'));
  console.log(chalk.gray('Usage: ./dokodemodoor.mjs <WEB_URL> <REPO_PATH> [--config config.yaml]'));
  console.log(chalk.gray('Help:  ./dokodemodoor.mjs --help'));
  process.exit(1);
}

const [webUrl, repoPath] = nonFlagArgs;

// Validate web URL
const webUrlValidation = validateWebUrl(webUrl);
if (!webUrlValidation.valid) {
  console.log(chalk.red(`❌ Invalid web URL: ${webUrlValidation.error}`));
  console.log(chalk.gray(`Expected format: https://example.com`));
  process.exit(1);
}

// Validate repository path
const repoPathValidation = await validateRepoPath(repoPath);
if (!repoPathValidation.valid) {
  console.log(chalk.red(`❌ Invalid repository path: ${repoPathValidation.error}`));
  console.log(chalk.gray(`Expected: Accessible local directory path`));
  process.exit(1);
}

// Success - show validated inputs
console.log(chalk.green('✅ Input validation passed:'));
console.log(chalk.gray(`   Target Web URL: ${webUrl}`));
console.log(chalk.gray(`   Target Repository: ${repoPathValidation.path}\n`));
console.log(chalk.gray(`   Config Path: ${configPath}\n`));
if (disableLoader) {
  console.log(chalk.yellow('⚙️  LOADER DISABLED - Progress indicator will not be shown\n'));
}

try {
  const result = await main(webUrl, repoPathValidation.path, configPath, disableLoader);
  console.log(chalk.green.bold('\n📄 FINAL REPORTS AVAILABLE:'));
  console.log(chalk.cyan(`   English: ${result.reportPath}`));
  if (result.reportPathKr) {
    console.log(chalk.cyan(`   Korean:  ${result.reportPathKr}`));
  }
  console.log(chalk.green.bold('\n📂 AUDIT LOGS AVAILABLE:'));
  console.log(chalk.cyan(`   ${result.auditLogsPath}`));

  process.exit(0);

} catch (error) {
  // Enhanced error boundary with proper logging
  if (error instanceof PentestError) {
    await logError(error, 'Main execution failed');
    console.log(chalk.red.bold('\n🚨 PENTEST EXECUTION FAILED'));
    console.log(chalk.red(`   Type: ${error.type}`));
    console.log(chalk.red(`   Retryable: ${error.retryable ? 'Yes' : 'No'}`));

    if (error.retryable) {
      console.log(chalk.yellow('   Consider running the command again or checking network connectivity.'));
    }
  } else {
    console.log(chalk.red.bold('\n🚨 UNEXPECTED ERROR OCCURRED'));
    console.log(chalk.red(`   Error: ${error?.message || error?.toString() || 'Unknown error'}`));

    if (process.env.DEBUG) {
      console.log(chalk.gray(`   Stack: ${error?.stack || 'No stack trace available'}`));
    }
  }

  process.exit(1);
}
