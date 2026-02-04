import { fs, path, $ } from 'zx';
import chalk from 'chalk';
import { PentestError } from './error-handling.js';
import { loadConfig } from './config/config-loader.js';
import { executeGitCommandWithRetry, preserveDeliverables } from './utils/git-manager.js';
import { getLocalISOString } from './utils/time-utils.js';
import { formatDuration } from './audit/utils.js';
import {
  AGENTS,
  PHASES,
  selectSession,
  validateAgent,
  validateAgentRange,
  validatePhase,
  checkPrerequisites,
  getNextAgent,
  markAgentCompleted,
  markAgentFailed,
  markAgentRunning,
  getSessionStatus,
  rollbackToAgent,
  updateSession
} from './session-manager.js';

// Check if target repository exists and is accessible
/**
 * [목적] 대상 레포 존재 여부 및 git 저장소 여부 검증.
 *
 * [호출자]
 * - runPhase() 실행 전
 *
 * [출력 대상]
 * - 유효하면 true 반환, 아니면 예외 발생
 *
 * [입력 파라미터]
 * - targetRepo (string)
 *
 * [반환값]
 * - Promise<boolean>
 *
 * [에러 처리]
 * - 경로 없음/비git 저장소일 때 PentestError 발생
 */
const validateTargetRepo = async (targetRepo) => {
  if (!targetRepo || !await fs.pathExists(targetRepo)) {
    throw new PentestError(
      `Target repository '${targetRepo}' not found or not accessible`,
      'filesystem',
      false,
      { targetRepo }
    );
  }

  // Check if it's a git repository
  const gitDir = path.join(targetRepo, '.git');
  if (!await fs.pathExists(gitDir)) {
    throw new PentestError(
      `Target repository '${targetRepo}' is not a git repository`,
      'validation',
      false,
      { targetRepo }
    );
  }

  return true;
};

/**
 * [목적] 완료된 세션의 deliverables 디렉터리를 보관용으로 리네임.
 *
 * [호출자]
 * - runSingleAgent()에서 세션 완료 시점
 *
 * [입력 파라미터]
 * - targetRepo (string)
 * - session (object)
 *
 * [반환값]
 * - Promise<void>
 */
const archiveDeliverablesIfComplete = async (targetRepo, session) => {
  if (!targetRepo || !session?.id) return;

  const deliverablesDir = path.join(targetRepo, 'deliverables');
  if (!await fs.pathExists(deliverablesDir)) return;

  const timestamp = getLocalISOString()
    .replace('T', '_')
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  const shortId = session.id.slice(0, 8);

  let archiveDir = path.join(targetRepo, `deliverables__${timestamp}_${shortId}`);
  let suffix = 1;
  while (await fs.pathExists(archiveDir)) {
    archiveDir = path.join(targetRepo, `deliverables__${timestamp}_${shortId}_${suffix++}`);
  }

  await fs.move(deliverablesDir, archiveDir);
  console.log(chalk.green(`📦 Archived deliverables → ${archiveDir}`));
};

/**
 * [목적] login-check 출력에서 상태 토큰을 추출.
 *
 * [호출자]
 * - runLoginCheckIfConfigured()
 *
 * [출력 대상]
 * - 마지막 상태 토큰 또는 null 반환
 *
 * [입력 파라미터]
 * - output (string)
 *
 * [반환값]
 * - string|null
 */
const parseLoginCheckStatus = (output) => {
  if (!output || typeof output !== 'string') return null;
  const matches = output.match(/LOGIN_(SUCCESS|FAILURE)/g);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1];
};

/**
 * [목적] 인증 플로우가 있을 때 login-check 에이전트를 실행.
 *
 * [호출자]
 * - recon 단계 시작 전
 *
 * [출력 대상]
 * - 로그인 실패 시 예외, 성공 시 void
 *
 * [입력 파라미터]
 * - session (object)
 * - runAgentPromptWithRetry (function)
 * - loadPrompt (function)
 *
 * [반환값]
 * - Promise<void>
 *
 * [부작용]
 * - login-check 에이전트 실행 및 로그 출력
 */
const runLoginCheckIfConfigured = async (session, runAgentPromptWithRetry, loadPrompt) => {
  if (!session?.configFile) return;

  // Skip if already completed to avoid redundant runs
  if (session.completedAgents && session.completedAgents.includes('login-check')) {
    console.log(chalk.gray('⏭️  Login verification already completed, skipping'));
    return;
  }

  const configResult = await loadConfig(session.configFile);
  const config = configResult.config;
  const distributedConfig = configResult.distributedConfig;

  if (!config?.authentication?.login_flow || config.authentication.login_flow.length === 0) {
    return;
  }

  const variables = {
    webUrl: session.webUrl,
    repoPath: session.repoPath,
    sourceDir: session.targetRepo
  };

  console.log(chalk.cyan('🔐 Running login verification (config-driven) before recon...'));

  // Mark as running
  await markAgentRunning(session.id, 'login-check');

  try {
    const prompt = await loadPrompt('login-check', variables, distributedConfig);
    const result = await runAgentPromptWithRetry(
      prompt,
      session.targetRepo,
      '*',
      '',
      'Login check agent',
      'login-check',
      chalk.gray,
      { id: session.id, webUrl: session.webUrl, repoPath: session.repoPath }
    );

    const status = parseLoginCheckStatus(result.result);
    if (status !== 'LOGIN_SUCCESS') {
      throw new PentestError(
        'Login verification failed (see login-check output)',
        'authentication',
        false,
        { status: status || 'UNKNOWN', output: (result.result || '').slice(0, 1200) }
      );
    }

    // Mark as completed in session state
    const { markAgentCompleted } = await import('./session-manager.js');
    await markAgentCompleted(session.id, 'login-check', result.checkpoint);

    console.log(chalk.green('✅ Login verification succeeded'));
  } catch (error) {
    const { markAgentFailed } = await import('./session-manager.js');
    await markAgentFailed(session.id, 'login-check');
    throw error;
  }
};

// Get git commit hash for checkpoint
/**
 * [목적] 체크포인트용 현재 git 커밋 해시 조회.
 *
 * [호출자]
 * - runSingleAgent(), runPhase() (체크포인트 추적)
 *
 * [출력 대상]
 * - 커밋 해시 문자열 반환
 *
 * [입력 파라미터]
 * - targetRepo (string)
 *
 * [반환값]
 * - Promise<string>
 *
 * [에러 처리]
 * - git 실패 시 PentestError 발생
 */
export const getGitCommitHash = async (targetRepo) => {
  try {
    const result = await executeGitCommandWithRetry(['git', 'rev-parse', 'HEAD'], targetRepo, 'getting commit hash');
    return result.stdout.trim();
  } catch (error) {
    throw new PentestError(
      `Failed to get git commit hash: ${error.message}`,
      'git',
      false,
      { targetRepo, originalError: error.message }
    );
  }
};

// Rollback git workspace to specific commit
/**
 * [목적] 특정 커밋으로 레포를 리셋하고 워크스페이스 정리.
 *
 * [호출자]
 * - 에이전트 롤백 중 rollbackTo()
 *
 * [출력 대상]
 * - git 워크스페이스 갱신 및 성공 로그 출력
 *
 * [입력 파라미터]
 * - targetRepo (string)
 * - commitHash (string)
 *
 * [반환값]
 * - Promise<void>
 *
 * [부작용]
 * - 디스크에서 git reset/clean 실행
 *
 * [에러 처리]
 * - git 실패 시 PentestError 발생
 */
const rollbackGitToCommit = async (targetRepo, commitHash) => {
  try {
    await preserveDeliverables(targetRepo, async () => {
      await executeGitCommandWithRetry(['git', 'reset', '--hard', commitHash], targetRepo, 'rollback to commit');
      await executeGitCommandWithRetry(['git', 'clean', '-fd', '-e', 'deliverables/', '-e', 'outputs/'], targetRepo, 'cleaning after rollback');
    });
    console.log(chalk.green(`✅ Git workspace rolled back to commit ${commitHash.substring(0, 8)}`));
  } catch (error) {
    throw new PentestError(
      `Failed to rollback git workspace: ${error.message}`,
      'git',
      false,
      { targetRepo, commitHash, originalError: error.message }
    );
  }
};

// Run a single agent with retry logic and checkpointing
/**
 * [목적] 단일 에이전트를 검증/체크포인트/에러처리 포함 실행.
 *
 * [호출자]
 * - runPhase(), runAgentRange(), rerunAgent()
 *
 * [출력 대상]
 * - 타이밍/비용/체크포인트 포함 결과 객체 반환
 *
 * [입력 파라미터]
 * - agentName (string)
 * - session (object)
 * - runAgentPromptWithRetry (function)
 * - loadPrompt (function)
 * - allowRerun (boolean)
 * - skipWorkspaceClean (boolean)
 * - queueData (object|null)
 *
 * [반환값]
 * - Promise<object>
 *
 * [부작용]
 * - 세션 저장/Deliverables/감사 로그 갱신
 *
 * [에러 처리]
 * - 검증/실행 실패 시 PentestError 발생
 */
const runSingleAgent = async (agentName, session, runAgentPromptWithRetry, loadPrompt, allowRerun = false, skipWorkspaceClean = false, queueData = null) => {
  // Validate agent first
  const agent = validateAgent(agentName);

  // Check if this agent should be skipped based on global config
  if (agentName.includes('-exploit')) {
    const { config } = await import('./config/env.js');
    if (config.dokodemodoor.skipExploitation) {
      console.log(chalk.yellow(`⏭️  Skipping exploit agent '${agentName}' (DOKODEMODOOR_SKIP_EXPLOITATION=true)`));
      const { markAgentSkipped } = await import('./session-manager.js');
      await markAgentSkipped(session.id, agentName);
      return Object.freeze({
        success: true,
        agentName,
        result: { skipped: true },
        timing: 0,
        cost: 0,
        completedAt: getLocalISOString()
      });
    }
  }

  console.log(chalk.cyan(`\n🤖 Running agent: ${agent.displayName}`));

  // Mark agent as running for status visibility
  await markAgentRunning(session.id, agentName);

  // Reload session to get latest state (important for agent ranges)
  const { getSession } = await import('./session-manager.js');
  const freshSession = await getSession(session.id);
  if (!freshSession) {
    throw new PentestError(`Session ${session.id} not found`, 'validation', false);
  }

  // Use fresh session for all subsequent checks
  session = freshSession;

  // Warn if session is completed
  if (session.status === 'completed') {
    console.log(chalk.yellow('⚠️  This session is already completed. Re-running will modify completed results.'));
  }

  // Block re-running completed agents unless explicitly allowed - use --rerun for explicit rollback and re-run
  if (!allowRerun && session.completedAgents.includes(agentName)) {
    throw new PentestError(
      `Agent '${agentName}' has already been completed. Use --rerun ${agentName} for explicit rollback and re-execution.`,
      'validation',
      false,
      {
        agentName,
        suggestion: `--rerun ${agentName}`,
        completedAgents: session.completedAgents
      }
    );
  }

  const targetRepo = session.targetRepo;
  await validateTargetRepo(targetRepo);

  // Check prerequisites
  checkPrerequisites(session, agentName);

  // Additional safety check: if this agent is not completed but we have uncommitted changes,
  // it might be from a previous interrupted run. Clean the workspace to be safe.
  // Skip workspace cleaning during parallel execution to avoid agents interfering with each other
  if (!session.completedAgents.includes(agentName) && !allowRerun && !skipWorkspaceClean) {
    try {
      const status = await executeGitCommandWithRetry(['git', 'status', '--porcelain'], targetRepo, 'checking workspace status');
      const hasUncommittedChanges = status.stdout.trim().length > 0;

      if (hasUncommittedChanges) {
        console.log(chalk.yellow(`    ⚠️  Detected uncommitted changes before running ${agentName}`));
        console.log(chalk.yellow(`    🧹 Cleaning workspace to ensure clean agent execution`));
        await executeGitCommandWithRetry(['git', 'reset', '--hard', 'HEAD'], targetRepo, 'cleaning workspace');
        await executeGitCommandWithRetry(['git', 'clean', '-fd', '-e', 'deliverables/', '-e', 'outputs/'], targetRepo, 'removing untracked files');
        console.log(chalk.green(`    ✅ Workspace cleaned successfully`));
      }
    } catch (error) {
      console.log(chalk.yellow(`    ⚠️ Could not check/clean workspace: ${error.message}`));
    }
  }

  // Create checkpoint before execution
  const variables = {
    webUrl: session.webUrl,
    repoPath: session.repoPath,
    sourceDir: targetRepo
  };

  // Add queue data for exploitation agents
  if (queueData && agentName.includes('-exploit')) {
    variables.vulnerabilities = queueData.vulnerabilities || [];
    variables.vulnerabilityCount = (queueData.vulnerabilities || []).length;
    variables.queueSummary = JSON.stringify(queueData, null, 2);
  }

  // Handle relative config paths - prepend configs/ if needed
  let distributedConfig = null;
  if (session.configFile) {
    const configResult = await loadConfig(session.configFile);
    distributedConfig = configResult.distributedConfig;
  }
  // Removed prompt snapshotting - using live prompts from repo

  // Initialize variables that will be used in both try and catch blocks
  let validationData = null;
  let timingData = null;
  let costData = null;

  try {
    if (agentName === 'recon') {
      const preReconPath = path.join(targetRepo, 'deliverables', 'pre_recon_deliverable.md');
      if (!await fs.pathExists(preReconPath)) {
        throw new PentestError(
          `Missing required pre-recon deliverable: ${preReconPath}`,
          'validation',
          false,
          { agentName, preReconPath, suggestion: 'Rerun pre-recon before recon.' }
        );
      }
    }

    // Special handling for PRE-RECON agent which orchestrates multiple tools
    if (agentName === 'pre-recon') {
      const { executePreReconPhase } = await import('./phases/pre-recon.js');
      const { loadConfig } = await import('./config/config-loader.js');
      const { checkToolAvailability } = await import('./tool-checker.js');

      const configPath = session.configFile;
      let config = null;
      if (configPath) {
        const configResult = await loadConfig(configPath);
        config = configResult.config;
      }

      const toolAvailability = await checkToolAvailability();

      const preReconResult = await executePreReconPhase(
        session.webUrl,
        targetRepo,
        variables,
        config,
        toolAvailability,
        session.id
      );

      const commitHash = await getGitCommitHash(targetRepo);
      // Mark as completed in session store
      await markAgentCompleted(session.id, agentName, commitHash);

      // Return a formatted successful result object
      return Object.freeze({
        success: true,
        agentName,
        result: preReconResult.report,
        timing: preReconResult.duration,
        cost: 0,
        checkpoint: commitHash,
        completedAt: getLocalISOString()
      });
    }

    // Load and run the appropriate prompt
    let promptName = getPromptName(agentName);
    const prompt = await loadPrompt(promptName, variables, distributedConfig);

    // Special pre-processing for report agent - assemble and prepare inputs
    if (agentName === 'report') {
      try {
        const { assembleFinalReport, prepareReportInputs } = await import('./phases/reporting.js');
        // First assemble the raw report from all deliverables
        await assembleFinalReport(targetRepo);
        // Then prepare the truncated inputs for the reporter agent
        await prepareReportInputs(targetRepo);
      } catch (err) {
        console.log(chalk.yellow(`   ⚠️  Warning: Failed to prepare report inputs/assembly: ${err.message}`));
      }
    }

    // Run login check BEFORE the agent if configured (unless the agent is login-check itself)
    if (session.configFile && agentName !== 'login-check') {
      await runLoginCheckIfConfigured(session, runAgentPromptWithRetry, loadPrompt);
    }

    // Get color function for this agent
    const getAgentColor = (agentName) => {
      const colorMap = {
        'sqli-vuln': chalk.red,
        'codei-vuln': chalk.red,
        'ssti-vuln': chalk.red,
        'pathi-vuln': chalk.red,
        'sqli-exploit': chalk.red,
        'codei-exploit': chalk.red,
        'ssti-exploit': chalk.red,
        'pathi-exploit': chalk.red,
        'xss-vuln': chalk.yellow,
        'xss-exploit': chalk.yellow,
        'auth-vuln': chalk.blue,
        'auth-exploit': chalk.blue,
        'ssrf-vuln': chalk.magenta,
        'ssrf-exploit': chalk.magenta,
        'authz-vuln': chalk.green,
        'authz-exploit': chalk.green,
        'recon-verify': chalk.blueBright
      };
      return colorMap[agentName] || chalk.cyan;
    };

    // Targeted Context Injection: Prevent specialists from repeating discovery
    let targetedContext = '';
    if (agentName.includes('-vuln') || agentName.includes('-exploit')) {
      const reconPath = path.join(targetRepo, 'deliverables', 'recon_deliverable.md');
      if (await fs.pathExists(reconPath)) {
        try {
          const reconContent = await fs.readFile(reconPath, 'utf8');
          targetedContext = `\n\n# TARGETED RECONNAISSANCE FINDINGS (MANDATORY STARTING POINT)\nUse the findings below to skip initial discovery. Do not run 'ls' on paths already identified. Proceed directly to analysis or exploitation of the following:\n\n${reconContent}`;
          console.log(chalk.blue(`   🎯 Injected targeted recon findings into ${agentName} context`));
        } catch (e) {
          console.log(chalk.yellow(`   ⚠️  Failed to read recon deliverable for context injection: ${e.message}`));
        }
      }
    }

    const result = await runAgentPromptWithRetry(
      prompt,
      targetRepo,
      '*',
      targetedContext, // Injected targeted findings
      AGENTS[agentName].displayName,
      agentName,  // Pass agent name for snapshot creation
      getAgentColor(agentName),  // Pass color function for this agent
      { id: session.id, webUrl: session.webUrl, repoPath: session.repoPath }  // Session metadata for audit logging
    );

    if (!result.success) {
      throw new PentestError(
        `Agent execution failed: ${result.error}`,
        'agent',
        result.retryable || false,
        { agentName, result }
      );
    }

    // Special post-processing for report agent - fallback write if save_deliverable failed
    if (agentName === 'report' && result.result) {
      const reportPath = path.join(targetRepo, 'deliverables', 'comprehensive_security_assessment_report.md');
      try {
        if (!await fs.pathExists(reportPath)) {
          await fs.writeFile(reportPath, result.result);
          console.log(chalk.green(`   ✅ Final report saved to ${reportPath}`));
        }
      } catch (err) {
        console.log(chalk.yellow(`   ⚠️  Warning: Could not save final report fallback: ${err.message}`));
      }
    }


    // Get commit hash for checkpoint (prefer hash returned by agent execution)
    const commitHash = result.checkpoint || await getGitCommitHash(targetRepo);

    // Extract timing and cost data from result if available
    timingData = result.duration;
    costData = result.cost || 0;

    if (agentName.includes('-vuln')) {
      // Extract vulnerability type from agent name (e.g., 'injection-vuln' -> 'injection')
      const vulnType = agentName.replace('-vuln', '');
      try {
        const { safeValidateQueueAndDeliverable } = await import('./queue-validation.js');
        const validation = await safeValidateQueueAndDeliverable(vulnType, targetRepo);

        if (validation.success) {
          // Log validation result (don't store - will be re-validated during exploitation phase)
          console.log(chalk.blue(`📋 Validation: ${validation.data.shouldExploit ? `Ready for exploitation (${validation.data.vulnerabilityCount} vulnerabilities)` : 'No vulnerabilities found'}`));
          validationData = {
            shouldExploit: validation.data.shouldExploit,
            vulnerabilityCount: validation.data.vulnerabilityCount
          };
        } else {
          const validationError = validation.error || new PentestError(
            `Validation failed for ${vulnType}: unknown error`,
            'validation',
            true,
            { vulnType }
          );
          console.log(chalk.yellow(`⚠️ Validation failed: ${validationError.message}`));
          throw validationError;
        }
      } catch (validationError) {
        const errorMsg = validationError?.message || String(validationError) || 'Unknown validation error';
        console.log(chalk.yellow(`⚠️ Could not validate ${vulnType}: ${errorMsg}`));
        throw validationError;
      }
    }

    // Mark agent as completed (validation not stored - will be re-checked during exploitation)
    await markAgentCompleted(session.id, agentName, commitHash);

    // If session completed, archive deliverables to avoid collisions on re-runs
    try {
      const { getSession } = await import('./session-manager.js');
      const updatedSession = await getSession(session.id);
      const { status } = getSessionStatus(updatedSession);
      if (status === 'completed') {
        await archiveDeliverablesIfComplete(updatedSession.targetRepo || targetRepo, updatedSession);
      }
    } catch (archiveError) {
      console.log(chalk.yellow(`⚠️  Failed to archive deliverables: ${archiveError.message}`));
    }

    // Only show completion message for sequential execution
    if (!skipWorkspaceClean) {
      console.log(chalk.green(`✅ Agent '${agentName}' completed successfully`));
    }

    // Return immutable result object with enhanced metadata
    return Object.freeze({
      success: true,
      agentName,
      result,
      validation: validationData,
      timing: timingData,
      cost: costData,
      checkpoint: commitHash,
      completedAt: getLocalISOString()
    });

  } catch (error) {
    // Mark agent as failed
    await markAgentFailed(session.id, agentName);

    // Only show failure message for sequential execution
    if (!skipWorkspaceClean) {
      const errorMsg = error?.message || String(error) || 'Unknown agent error';
      console.log(chalk.red(`❌ Agent '${agentName}' failed: ${errorMsg}`));
    }

    // Return immutable error object with enhanced context
    const errorResult = Object.freeze({
      success: false,
      agentName,
      error: {
        message: error?.message || String(error) || 'Unknown error',
        type: error?.constructor?.name || 'Error',
        retryable: error?.retryable || false,
        originalError: error
      },
      validation: validationData,
      timing: timingData,
      failedAt: getLocalISOString(),
      context: {
        targetRepo,
        promptName: getPromptName(agentName),
        sessionId: session.id
      }
    });

    // Throw enhanced error with preserved context
    const enhancedError = new PentestError(
      `Agent '${agentName}' execution failed: ${error.message}`,
      'agent',
      error.retryable || false,
      {
        agentName,
        sessionId: session.id,
        originalError: error.message,
        errorResult
      }
    );

    throw enhancedError;
  }
};

// Run multiple agents in sequence
/**
 * [목적] 연속 범위 에이전트를 순차 실행.
 *
 * [호출자]
 * - CLI range execution.
 *
 * [출력 대상]
 * - Runs agents and propagates first failure.
 *
 * [입력 파라미터]
 * - startAgent (string)
 * - endAgent (string)
 * - session (object)
 * - runAgentPromptWithRetry (function)
 * - loadPrompt (function)
 *
 * [반환값]
 * - Promise<void>
 */
const runAgentRange = async (startAgent, endAgent, session, runAgentPromptWithRetry, loadPrompt) => {
  const agents = validateAgentRange(startAgent, endAgent);

  console.log(chalk.cyan(`\n🔄 Running agent range: ${startAgent} to ${endAgent} (${agents.length} agents)`));

  for (const agent of agents) {
    // Skip if already completed
    if (session.completedAgents.includes(agent.name)) {
      console.log(chalk.gray(`⏭️  Agent '${agent.name}' already completed, skipping`));
      continue;
    }

    try {
      await runSingleAgent(agent.name, session, runAgentPromptWithRetry, loadPrompt);
    } catch (error) {
      console.log(chalk.red(`❌ Agent range execution stopped at '${agent.name}' due to failure`));
      throw error;
    }
  }

  console.log(chalk.green(`✅ Agent range ${startAgent} to ${endAgent} completed successfully`));
};

// Run vulnerability agents in parallel
/**
 * [목적] 취약점 분석 에이전트를 스태거드 병렬 실행.
 *
 * [호출자]
 * - runPhase() when phase is vulnerability-analysis.
 *
 * [출력 대상]
 * - Returns { completed, failed } arrays.
 *
 * [입력 파라미터]
 * - session (object)
 * - runAgentPromptWithRetry (function)
 * - loadPrompt (function)
 *
 * [반환값]
 * - Promise<object>
 */
const runParallelVuln = async (session, runAgentPromptWithRetry, loadPrompt) => {
  const { getSession } = await import('./session-manager.js');
  const freshSession = await getSession(session.id);
  const currentSession = freshSession || session;

  const vulnAgents = PHASES['vulnerability-analysis'];
  const activeAgents = vulnAgents.filter(agent => !currentSession.completedAgents.includes(agent));

  if (activeAgents.length === 0) {
    console.log(chalk.gray('⏭️  All vulnerability agents already completed'));
    return { completed: vulnAgents, failed: [] };
  }

  console.log(chalk.cyan(`\n🚀 Starting ${activeAgents.length} vulnerability analysis specialists in parallel...`));
  console.log(chalk.gray('    Specialists: ' + activeAgents.join(', ')));
  console.log();

  const startTime = Date.now();

  // Collect all results without logging individual completions
  const results = await Promise.allSettled(
    activeAgents.map(async (agentName, index) => {
      // Add 2-second stagger to prevent API overwhelm
      await new Promise(resolve => setTimeout(resolve, index * 2000));

      const result = await runSingleAgent(agentName, currentSession, runAgentPromptWithRetry, loadPrompt, false, true);
      return { agentName, ...result, attempts: result.result?.turns >= 1 ? 1 : 1 }; // runSingleAgent handles attempts internally
    })
  );

  const totalDuration = Date.now() - startTime;

  // Process and display results in a nice table
  console.log(chalk.cyan('\n📊 Vulnerability Analysis Results'));
  console.log(chalk.gray('─'.repeat(80)));

  // Table header
  console.log(chalk.bold('Agent                  Status     Vulns  Attempt  Duration    Cost'));
  console.log(chalk.gray('─'.repeat(80)));

  const completed = [];
  const failed = [];

  results.forEach((result, index) => {
    const agentName = activeAgents[index];
    const agentDisplay = agentName.padEnd(22);

    if (result.status === 'fulfilled' && result.value.success) {
      const data = result.value;
      completed.push(agentName);

      const vulnCount = data.validation?.vulnerabilityCount || 0;
      const duration = formatDuration(data.timing || 0);
      const cost = `$${(data.cost || 0).toFixed(4)}`;

      console.log(
        `${chalk.green(agentDisplay)} ${chalk.green('✓ Success')}  ${vulnCount.toString().padStart(5)}  ` +
        `${data.attempts}/3      ${duration.padEnd(11)} ${cost}`
      );

      // Show log file path for detailed review
      if (data.logFile) {
        const relativePath = path.relative(process.cwd(), data.logFile);
        console.log(chalk.gray(`  └─ Detailed log: ${relativePath}`));
      }
    } else {
      const data = result.status === 'fulfilled' ? result.value : null;
      const error = data?.error || result.reason?.error || result.reason || { message: 'Unknown error' };
      failed.push({ agent: agentName, error: error.message });

      const attempts = data?.attempts || result.reason?.attempts || 1;

      console.log(
        `${chalk.red(agentDisplay)} ${chalk.red('✗ Failed ')}     -  ` +
        `${attempts}/3      -           -`
      );
      const errorMsg = error?.message || String(error) || 'Unknown error';
      console.log(chalk.red(`  └─ ${errorMsg.substring(0, 60)}...`));
    }
  });

  console.log(chalk.gray('─'.repeat(80)));
  console.log(chalk.cyan(`Summary: ${completed.length}/${activeAgents.length} succeeded in ${formatDuration(totalDuration)}`));

  return { completed, failed };
};

// Run exploitation agents in parallel
/**
 * [목적] 자격 검증 후 익스플로잇 에이전트를 병렬 실행.
 *
 * [호출자]
 * - runPhase() when phase is exploitation.
 *
 * [출력 대상]
 * - Returns { completed, failed } arrays.
 *
 * [입력 파라미터]
 * - session (object)
 * - runAgentPromptWithRetry (function)
 * - loadPrompt (function)
 *
 * [반환값]
 * - Promise<object>
 *
 * [부작용]
 * - Reads queue files to determine eligibility.
 */
const runParallelExploit = async (session, runAgentPromptWithRetry, loadPrompt) => {
  const exploitAgents = PHASES['exploitation'];

  // Get fresh session data to ensure we have the latest vulnerability analysis results
  // This prevents race conditions where parallel vuln agents haven't updated session state yet
  const { getSession } = await import('./session-manager.js');
  const freshSession = await getSession(session.id);

  // Load validation module
  const { safeValidateQueueAndDeliverable } = await import('./queue-validation.js');

  // Only run exploit agents whose vuln counterparts completed successfully AND found vulnerabilities
  const eligibilityChecks = await Promise.all(
    exploitAgents.map(async (agentName) => {
      const vulnAgentName = agentName.replace('-exploit', '-vuln');

      // Must have completed the vulnerability analysis successfully
      if (!freshSession.completedAgents.includes(vulnAgentName)) {
        if (freshSession.failedAgents.includes(vulnAgentName)) {
          console.log(chalk.red(`✗ ${agentName} ineligible (vulnerability analysis '${vulnAgentName}' failed)`));
        } else {
          console.log(chalk.gray(`Skipping ${agentName} (dependency '${vulnAgentName}' not completed)`));
        }
        return { agentName, eligible: false };
      }

      // Check if vulnerabilities were found by validating the queue file
      const vulnType = vulnAgentName.replace('-vuln', '');
      const validation = await safeValidateQueueAndDeliverable(vulnType, freshSession.targetRepo);

      if (!validation.success) {
        console.log(chalk.red(`✗ ${agentName} ineligible (failed to validate queue for '${vulnAgentName}': ${validation.error?.message || 'invalid format'})`));
        return { agentName, eligible: false };
      }

      if (!validation.data.shouldExploit) {
        console.log(chalk.gray(`Skipping ${agentName} (no vulnerabilities found in ${vulnAgentName})`));
        return { agentName, eligible: false };
      }

      console.log(chalk.blue(`✓ ${agentName} eligible (${validation.data.vulnerabilityCount} vulnerabilities from ${vulnAgentName})`));
      return { agentName, eligible: true };
    })
  );

  const eligibleAgents = eligibilityChecks
    .filter(check => check.eligible)
    .map(check => check.agentName);

  const activeAgents = eligibleAgents.filter(agent => !freshSession.completedAgents.includes(agent));

  if (activeAgents.length === 0) {
    if (eligibleAgents.length === 0) {
      console.log(chalk.gray('⏭️  No exploitation agents eligible (no vulnerabilities found)'));
    } else {
      console.log(chalk.gray('⏭️  All eligible exploitation agents already completed'));
    }
    return { completed: eligibleAgents, failed: [] };
  }

  console.log(chalk.cyan(`\n🎯 Starting ${activeAgents.length} exploitation specialists in parallel...`));
  console.log(chalk.gray('    Specialists: ' + activeAgents.join(', ')));
  console.log();

  const startTime = Date.now();

  // Collect all results without logging individual completions
  const results = await Promise.allSettled(
    activeAgents.map(async (agentName, index) => {
      // Add 2-second stagger to prevent API overwhelm
      await new Promise(resolve => setTimeout(resolve, index * 2000));

      // Load queue data for this exploitation agent
      let queueData = null;
      try {
        // One-to-one mapping for all agents
        const vulnType = agentName.replace('-exploit', '');
        const queuePath = path.join(freshSession.targetRepo, 'deliverables', `${vulnType}_exploitation_queue.json`);

        if (await fs.pathExists(queuePath)) {
          const queueContent = await fs.readFile(queuePath, 'utf8');
          queueData = JSON.parse(queueContent);
        }
      } catch (error) {
        console.log(chalk.yellow(`⚠️  Failed to load queue data for ${agentName}: ${error.message}`));
      }

      // Retry logic for exploitation agents (max 3 attempts)
      let attempts = 0;
      let lastError = null;
      let result = null;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        attempts++;
        try {
          // Run agent with queue data passed as additional context
          result = await runSingleAgent(
            agentName,
            freshSession,
            runAgentPromptWithRetry,
            loadPrompt,
            false,
            true,
            queueData  // Pass queue data to agent
          );

          // Success - break out of retry loop
          break;
        } catch (error) {
          lastError = error;

          if (attempts < maxAttempts) {
            console.log(chalk.yellow(`⚠️  ${agentName} attempt ${attempts}/${maxAttempts} failed: ${error.message}`));
            console.log(chalk.yellow(`   Retrying in 5 seconds...`));
            await new Promise(resolve => setTimeout(resolve, 5000));
          } else {
            console.log(chalk.red(`❌ ${agentName} failed after ${maxAttempts} attempts`));
          }
        }
      }

      // If all attempts failed, throw the last error
      if (!result) {
        throw lastError || new Error('All exploitation attempts failed');
      }

      return { agentName, ...result, attempts };
    })
  );

  const totalDuration = Date.now() - startTime;

  // Process and display results in a nice table
  console.log(chalk.cyan('\n🎯 Exploitation Results'));
  console.log(chalk.gray('─'.repeat(80)));

  // Table header
  console.log(chalk.bold('Agent                  Status     Result Attempt  Duration    Cost'));
  console.log(chalk.gray('─'.repeat(80)));

  const completed = [];
  const failed = [];

  // Helper function to validate exploitation evidence
  /**
   * [목적] 익스플로잇 증거 출력 유효성 검증.
   *
   * [호출자]
   * - runParallelExploit() when summarizing exploit results.
   *
   * [출력 대상]
   * - Returns validation status/result/reason.
   *
   * [입력 파라미터]
   * - agentName (string)
   * - sourceDir (string)
   *
   * [반환값]
   * - Promise<object>
   *
   * [부작용]
   * - Reads evidence files from deliverables/.
   */
  const validateExploitationEvidence = async (agentName, sourceDir) => {
    // Check if exploitation was skipped globally
    // When DOKODEMODOOR_SKIP_EXPLOITATION=true, agents are marked as completed
    // but no actual exploitation is performed, so we return a success status
    // to allow report generation to proceed
    const { config } = await import('./config/env.js');
    if (config.dokodemodoor.skipExploitation) {
      return {
        success: true,
        result: 'Skipped',
        reason: 'Exploitation phase skipped per configuration'
      };
    }

    const vulnType = agentName.replace('-exploit', '');
    const jsonEvidenceFile = path.join(sourceDir, 'deliverables', `${vulnType}_exploitation_evidence.json`);
    const mdEvidenceFile = path.join(sourceDir, 'deliverables', `${vulnType}_exploitation_evidence.md`);

    try {
      const jsonExists = await fs.pathExists(jsonEvidenceFile);
      const mdExists = !jsonExists && await fs.pathExists(mdEvidenceFile);

      if (!jsonExists && !mdExists) {
        return { success: false, result: 'No Evidence', reason: 'Evidence file not created (.json or .md)' };
      }

      const evidenceFile = jsonExists ? jsonEvidenceFile : mdEvidenceFile;
      const isJson = jsonExists;
      const evidenceContent = await fs.readFile(evidenceFile, 'utf8');

      if (isJson) {
        const { validateEvidenceJson } = await import('../mcp-server/src/validation/evidence-validator.js');
        const validation = validateEvidenceJson(evidenceContent);

        if (!validation.valid) {
          return { success: false, result: 'Invalid', reason: validation.message || 'Invalid evidence structure' };
        }

        const evidenceData = validation.data || JSON.parse(evidenceContent);
        const vulnerabilities = Array.isArray(evidenceData.vulnerabilities)
          ? evidenceData.vulnerabilities
          : [];

        if (vulnerabilities.length === 0) {
          return { success: true, result: 'No Vulns', reason: 'No vulnerabilities evidenced' };
        }

        const exploitedCount = vulnerabilities.filter(vuln => vuln.verdict === 'EXPLOITED').length;
        const potentialCount = vulnerabilities.filter(vuln => vuln.verdict === 'POTENTIAL').length;

        if (exploitedCount > 0) {
          return { success: true, result: `${exploitedCount} Exploited`, reason: 'Successfully exploited vulnerabilities' };
        }
        if (potentialCount > 0) {
          return { success: true, result: 'Potential', reason: 'Potential vulnerabilities identified' };
        }
      } else {
        // Fallback for Markdown evidence - check for EXPLOITED pattern
        const exploitedMatch = evidenceContent.match(/verdict["']?\s*:\s*["']?EXPLOITED["']?/i) ||
                              evidenceContent.match(/\[[✓x]\]\s*EXPLOITED/i) ||
                              evidenceContent.includes('Verdict: EXPLOITED');

        if (exploitedMatch) {
          return { success: true, result: 'Exploited', reason: 'Exploitation confirmed via Markdown pattern match' };
        }

        if (evidenceContent.includes('POTENTIAL')) {
          return { success: true, result: 'Potential', reason: 'Potential vulnerability noted in Markdown' };
        }
      }

      return { success: true, result: 'No Vulns', reason: 'No exploitable vulnerabilities found' };
    } catch (error) {
      return { success: false, result: 'Error', reason: `Failed to validate evidence: ${error.message}` };
    }
  };

  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const agentName = activeAgents[index];
    const agentDisplay = agentName.padEnd(22);

    if (result.status === 'fulfilled' && result.value.success) {
      const data = result.value;
      completed.push(agentName);

      // Validate exploitation evidence
      const validation = await validateExploitationEvidence(agentName, freshSession.targetRepo);
      const exploitResult = validation.result;
      const duration = formatDuration(data.timing || 0);
      const cost = `$${(data.cost || 0).toFixed(4)}`;

      // Color based on validation result
      const resultColor = validation.success && exploitResult.includes('Exploited')
        ? chalk.green
        : validation.success && exploitResult === 'Potential'
        ? chalk.yellow
        : validation.success && exploitResult === 'No Vulns'
        ? chalk.gray
        : chalk.red;

      console.log(
        `${chalk.green(agentDisplay)} ${chalk.green('✓ Success')}  ${resultColor(exploitResult.padEnd(6))}  ` +
        `${data.attempts}/3      ${duration.padEnd(11)} ${cost}`
      );

      // Show validation details
      if (validation.reason) {
        console.log(chalk.gray(`  └─ ${validation.reason}`));
      }

      // Show log file path for detailed review
      if (data.logFile) {
        const relativePath = path.relative(process.cwd(), data.logFile);
        console.log(chalk.gray(`  └─ Detailed log: ${relativePath}`));
      }
    } else {
      const data = result.status === 'fulfilled' ? result.value : null;
      const error = data?.error || result.reason?.error || result.reason || { message: 'Unknown error' };
      failed.push({ agent: agentName, error: error.message });

      const attempts = data?.attempts || result.reason?.attempts || 1;

      console.log(
        `${chalk.red(agentDisplay)} ${chalk.red('✗ Failed ')}  -      ` +
        `${attempts}/3      -           -`
      );
      console.log(chalk.gray(`  └─ ${error.message?.substring(0, 60)}...`));
    }
  }

  console.log(chalk.gray('─'.repeat(80)));
  console.log(chalk.cyan(`Summary: ${completed.length}/${activeAgents.length} succeeded in ${formatDuration(totalDuration)}`));

  return { completed, failed };
};

// Run all agents in a phase
/**
 * [목적] 단계별 적절한 병렬성으로 에이전트를 실행.
 *
 * [호출자]
 * - runAll() and CLI phase commands.
 *
 * [출력 대상]
 * - Runs agents and logs phase results.
 *
 * [입력 파라미터]
 * - phaseName (string)
 * - session (object)
 * - runAgentPromptWithRetry (function)
 * - loadPrompt (function)
 *
 * [반환값]
 * - Promise<void>
 */
export const runPhase = async (phaseName, session, runAgentPromptWithRetry, loadPrompt) => {
  // Get fresh session state to ensure we have latest completedAgents
  const { getSession: getFreshSession } = await import('./session-manager.js');
  const freshSession = await getFreshSession(session.id);
  const currentSession = freshSession || session;

  console.log(chalk.cyan(`\n📋 Running phase: ${phaseName} (parallel execution)`));

  // Use parallel execution for both vulnerability-analysis and exploitation phases
  if (phaseName === 'vulnerability-analysis') {
    console.log(chalk.cyan('🚀 Using parallel execution for 5x faster vulnerability analysis'));
    const results = await runParallelVuln(currentSession, runAgentPromptWithRetry, loadPrompt);

    if (results.failed.length > 0) {
      console.log(chalk.yellow(`⚠️  ${results.failed.length} agents failed, but phase continues`));
      results.failed.forEach(failure => {
        console.log(chalk.red(`   - ${failure.agent}: ${failure.error}`));
      });
    }

    console.log(chalk.green(`✅ Phase '${phaseName}' completed: ${results.completed.length} succeeded, ${results.failed.length} failed`));
    return;
  }

  if (phaseName === 'exploitation') {
    // Check if exploitation should be skipped (e.g., for local LLM performance constraints)
    const { config } = await import('./config/env.js');
    if (config.dokodemodoor.skipExploitation) {
      console.log(chalk.yellow('⏭️  Skipping exploitation phase (DOKODEMODOOR_SKIP_EXPLOITATION=true)'));
      console.log(chalk.gray('   Reason: Local LLM performance constraints or user configuration'));
      console.log(chalk.gray('   All exploitation agents will be marked as skipped'));

      const { markAgentSkipped } = await import('./session-manager.js');
      const exploitAgents = PHASES['exploitation'];
      const skipped = [];

      // Mark as skipped sequentially to ensure session store stability
      for (const agentName of exploitAgents) {
        if (!currentSession.completedAgents.includes(agentName)) {
          await markAgentSkipped(currentSession.id, agentName);
          skipped.push(agentName);
        }
      }
      return { completed: [], failed: [], skipped, phaseSkipped: true };
    }

    console.log(chalk.cyan('🎯 Using parallel execution for 5x faster exploitation'));
    const results = await runParallelExploit(currentSession, runAgentPromptWithRetry, loadPrompt);

    if (results.failed.length > 0) {
      console.log(chalk.yellow(`⚠️  ${results.failed.length} agents failed, but phase continues`));
      results.failed.forEach(failure => {
        console.log(chalk.red(`   - ${failure.agent}: ${failure.error}`));
      });
    }

    console.log(chalk.green(`✅ Phase '${phaseName}' completed: ${results.completed.length} succeeded, ${results.failed.length} failed`));
    return;
  }

  if (phaseName === 'reconnaissance') {
    await runLoginCheckIfConfigured(currentSession, runAgentPromptWithRetry, loadPrompt);

    // Reload session AGAIN after login-check because it modifies session.completedAgents
    const freshSessionAfterLogin = await getFreshSession(session.id);
    if (freshSessionAfterLogin) {
      // Update local currentSession for the upcoming loop/checks
      Object.assign(currentSession, freshSessionAfterLogin);
    }
  }

  // For other phases (pre-reconnaissance, reconnaissance, reporting), run agents sequentially
  const agents = validatePhase(phaseName);
  const results = [];
  for (const agent of agents) {
    if (currentSession.completedAgents.includes(agent.name)) {
      console.log(chalk.gray(`⏭️  Agent '${agent.name}' already completed, skipping`));
      continue;
    }
    const result = await runSingleAgent(agent.name, currentSession, runAgentPromptWithRetry, loadPrompt);
    results.push(result);
  }
  console.log(chalk.green(`✅ Phase '${phaseName}' completed successfully`));
  return results;
};

// Rollback to specific agent checkpoint
/**
 * [목적] git 워크스페이스와 세션 상태를 특정 체크포인트로 롤백.
 *
 * [호출자]
 * - CLI rollback and rerun flows.
 *
 * [출력 대상]
 * - Updates git workspace, session store, and audit logs.
 *
 * [입력 파라미터]
 * - targetAgent (string)
 * - session (object)
 *
 * [반환값]
 * - Promise<void>
 */
export const rollbackTo = async (targetAgent, session) => {
  console.log(chalk.yellow(`🔄 Rolling back to agent: ${targetAgent}`));

  await validateTargetRepo(session.targetRepo);
  validateAgent(targetAgent);

  if (!session.checkpoints[targetAgent]) {
    throw new PentestError(
      `No checkpoint found for agent '${targetAgent}' in session history`,
      'validation',
      false,
      { targetAgent, availableCheckpoints: Object.keys(session.checkpoints) }
    );
  }

  const commitHash = session.checkpoints[targetAgent];

  // Rollback git workspace
  await rollbackGitToCommit(session.targetRepo, commitHash);

  // Update session state (removes agents from completedAgents)
  await rollbackToAgent(session.id, targetAgent);

  // Mark rolled-back agents in audit system (for forensic trail)
  try {
    const { AuditSession } = await import('./audit/index.js');
    const auditSession = new AuditSession(session);
    await auditSession.initialize();

    // Find agents that were rolled back (agents after targetAgent)
    const targetOrder = AGENTS[targetAgent].order;
    const rolledBackAgents = Object.values(AGENTS)
      .filter(agent => agent.order > targetOrder)
      .map(agent => agent.name);

    // Mark them as rolled-back in audit system
    if (rolledBackAgents.length > 0) {
      await auditSession.markMultipleRolledBack(rolledBackAgents);
      console.log(chalk.gray(`   Marked ${rolledBackAgents.length} agents as rolled-back in audit logs`));
    }
  } catch (error) {
    // Non-critical: rollback succeeded even if audit update failed
    console.log(chalk.yellow(`   ⚠️ Failed to update audit logs: ${error.message}`));
  }

  console.log(chalk.green(`✅ Successfully rolled back to agent '${targetAgent}'`));
};

// Rerun specific agent (isolated mode - only affects target agent)
/**
 * [목적] 선택적 캐스케이드 롤백과 함께 에이전트 재실행.
 *
 * [호출자]
 * - CLI rerun command.
 *
 * [출력 대상]
 * - Executes agent again and updates session/audit state.
 *
 * [입력 파라미터]
 * - agentName (string)
 * - session (object)
 * - runAgentPromptWithRetry (function)
 * - loadPrompt (function)
 * - cascade (boolean)
 *
 * [반환값]
 * - Promise<object>
 */
export const rerunAgent = async (agentName, session, runAgentPromptWithRetry, loadPrompt, cascade = false) => {
  console.log(chalk.cyan(`🔁 Rerunning agent: ${agentName}`));

  const agent = validateAgent(agentName);

  if (cascade) {
    // CASCADING MODE: Rollback to prerequisite and invalidate all subsequent agents
    console.log(chalk.yellow(`⚠️  Cascade mode: All agents after ${agentName} will be rolled back`));

    let rollbackTarget = null;
    if (agent.prerequisites.length > 0) {
      const completedPrereqs = agent.prerequisites.filter(prereq =>
        session.completedAgents.includes(prereq)
      );
      if (completedPrereqs.length > 0) {
        rollbackTarget = completedPrereqs.reduce((latest, current) =>
          AGENTS[current].order > AGENTS[latest].order ? current : latest
        );
      }
    }

    if (rollbackTarget) {
      console.log(chalk.blue(`📍 Rolling back to prerequisite: ${rollbackTarget}`));
      await rollbackTo(rollbackTarget, session);
    } else if (agent.name === 'pre-recon') {
      console.log(chalk.blue(`📍 Rolling back to initial repository state`));
      try {
        const initialCommit = await executeGitCommandWithRetry(['git', 'log', '--reverse', '--format=%H'], session.targetRepo, 'finding initial commit');
        const firstCommit = initialCommit.stdout.trim().split('\n')[0];
        await rollbackGitToCommit(session.targetRepo, firstCommit);
      } catch (error) {
        console.log(chalk.yellow(`⚠️ Could not find initial commit, using HEAD: ${error.message}`));
      }
    }
  } else {
    // ISOLATED MODE: Only rerun this specific agent without affecting others
    console.log(chalk.blue(`📍 Isolated rerun: Only ${agentName} will be affected`));

    // If agent was previously completed, we need to rollback ONLY this agent
    if (session.completedAgents.includes(agentName)) {
      // Find the checkpoint of the immediate prerequisite
      let targetCheckpoint = null;

      if (agent.prerequisites.length > 0) {
        const completedPrereqs = agent.prerequisites.filter(prereq =>
          session.completedAgents.includes(prereq)
        );
        if (completedPrereqs.length > 0) {
          const lastPrereq = completedPrereqs.reduce((latest, current) =>
            AGENTS[current].order > AGENTS[latest].order ? current : latest
          );
          targetCheckpoint = session.checkpoints[lastPrereq];
        }
      }

      if (targetCheckpoint) {
        console.log(chalk.gray(`   Restoring code to prerequisite checkpoint: ${targetCheckpoint.substring(0, 8)}`));
        await rollbackGitToCommit(session.targetRepo, targetCheckpoint);
      }

      // Remove ONLY this agent from completedAgents (don't touch others)
      const { getSession } = await import('./session-manager.js');
      const freshSession = await getSession(session.id);

      const updates = {
        completedAgents: freshSession.completedAgents.filter(a => a !== agentName),
        failedAgents: freshSession.failedAgents.filter(a => a !== agentName),
        checkpoints: Object.fromEntries(
          Object.entries(freshSession.checkpoints).filter(([agent]) => agent !== agentName)
        )
      };

      await updateSession(session.id, updates);

      // Mark as rolled-back in audit (only this agent)
      try {
        const { AuditSession } = await import('./audit/index.js');
        const auditSession = new AuditSession(freshSession);
        await auditSession.initialize();
        await auditSession.markMultipleRolledBack([agentName]);
        console.log(chalk.gray(`   Marked ${agentName} as rolled-back in audit logs`));
      } catch (error) {
        console.log(chalk.yellow(`   ⚠️ Failed to update audit logs: ${error.message}`));
      }

      // Reload session after updates
      session = await getSession(session.id);
    }
  }

  // Run the target agent (allow rerun since we've explicitly prepared for it)
  await runSingleAgent(agentName, session, runAgentPromptWithRetry, loadPrompt, true);

  console.log(chalk.green(`✅ Agent '${agentName}' rerun completed successfully`));
};

// Run all remaining agents to completion
/**
 * [목적] 남은 에이전트를 완료까지 순차 실행.
 *
 * [호출자]
 * - CLI run-all command.
 *
 * [출력 대상]
 * - Executes agents and updates session status.
 *
 * [입력 파라미터]
 * - session (object)
 * - runAgentPromptWithRetry (function)
 * - loadPrompt (function)
 *
 * [반환값]
 * - Promise<void>
 */
export const runAll = async (session, runAgentPromptWithRetry, loadPrompt) => {
  // Get all agents in order
  const allAgentNames = Object.keys(AGENTS);
  const completedOrSkipped = new Set([
    ...(session.completedAgents || []),
    ...(session.skippedAgents || [])
  ]);

  console.log(chalk.cyan(`\n🚀 Running all remaining agents to completion`));
  console.log(chalk.gray(`Current progress: ${completedOrSkipped.size}/${allAgentNames.length} agents completed`));

  // Find remaining agents (not yet completed)
  const remainingAgents = allAgentNames.filter(agentName =>
    !completedOrSkipped.has(agentName)
  );

  if (remainingAgents.length === 0) {
    console.log(chalk.green('✅ All agents already completed!'));
    return;
  }

  console.log(chalk.blue(`📋 Remaining agents: ${remainingAgents.join(', ')}`));
  console.log();

  // Run each remaining agent in sequence
  for (const agentName of remainingAgents) {
    await runSingleAgent(agentName, session, runAgentPromptWithRetry, loadPrompt);
  }

  console.log(chalk.green(`\n🎉 All agents completed successfully! Session marked as completed.`));
};

// Display session status
/**
 * [목적] 세션 상태 요약을 사람이 읽기 쉬운 형태로 출력.
 *
 * [호출자]
 * - CLI status command.
 *
 * [출력 대상]
 * - Writes formatted status to stdout.
 *
 * [입력 파라미터]
 * - session (object)
 *
 * [반환값]
 * - Promise<void>
 */
export const displayStatus = async (session) => {
  const { status, completionPercentage } = getSessionStatus(session);
  const timeAgo = getTimeAgo(session.lastActivity);

  // Load audit data for richer metrics
  let auditMetrics = null;
  try {
    const { AuditSession } = await import('./audit/index.js');
    const auditSession = new AuditSession(session);
    await auditSession.initialize();
    auditMetrics = await auditSession.getMetrics();
  } catch (error) {
    // Non-critical: continue with basic session data if audit logs unavailable
  }

  console.log('\n' + chalk.bold.cyan('='.repeat(60)));
  console.log(chalk.bold.white('  🛡️  DOKODEMODOOR PENTEST STATUS'));
  console.log(chalk.bold.cyan('='.repeat(60)));

  // Core metadata
  console.log(`${chalk.bold('Target:')} ${chalk.blue(session.webUrl)}`);
  console.log(`${chalk.bold('Repo  :')} ${chalk.gray(session.targetRepo || session.repoPath)}`);

  // Overall status with progress bar
  const statusIcon = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '🔄';
  const statusColor = status === 'completed' ? chalk.green : status === 'failed' ? chalk.red : chalk.blue;

  const barWidth = 30;
  const completedWidth = Math.round((completionPercentage / 100) * barWidth);
  const progressBar = chalk.green('█'.repeat(completedWidth)) + chalk.gray('░'.repeat(barWidth - completedWidth));

  console.log(`${chalk.bold('Status:')} ${statusColor(`[${statusIcon} ${status.toUpperCase()}]`)} ${progressBar} ${completionPercentage}%`);

  if (auditMetrics) {
    const totalCost = (auditMetrics.metrics.total_cost_usd || 0).toFixed(4);
    const totalTime = formatDuration(auditMetrics.metrics.total_duration_ms || 0);
    console.log(`${chalk.bold('Usage :')} ${chalk.yellow(`💰 $${totalCost}`)} | ${chalk.blue(`⏱️  ${totalTime}`)} | ${chalk.gray(`📅 ${timeAgo}`)}`);
  } else {
    console.log(`${chalk.bold('Usage :')} ${chalk.gray(`📅 Last activity ${timeAgo}`)}`);
  }

  if (session.configFile) {
    console.log(`${chalk.bold('Config:')} ${chalk.gray(session.configFile)}`);
  }

  console.log(chalk.cyan('-'.repeat(60)));

  // Display agents grouped by phase
  const phaseNames = Object.keys(PHASES);

  for (const phaseName of phaseNames) {
    const phaseAgents = PHASES[phaseName];
    const phaseDisplayName = phaseName.split('-').map(word =>
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');

    console.log(`\n${chalk.bold.white(phaseDisplayName)}`);

    for (const agentName of phaseAgents) {
      const agent = AGENTS[agentName];
      let agentIcon, agentStatusText, agentStatusColor;

      // Check audit metrics for more accurate individual agent status
      const auditAgent = auditMetrics?.metrics?.agents?.[agentName];
      const isCompleted = session.completedAgents.includes(agentName);
      const isSkipped = (session.skippedAgents || []).includes(agentName);
      const isFailed = session.failedAgents.includes(agentName);
      const isRunning = (session.runningAgents || []).includes(agentName);

      if (isCompleted) {
        agentIcon = chalk.green('✅');
        agentStatusText = 'COMPLETED';
        agentStatusColor = chalk.green;
      } else if (isRunning) {
        agentIcon = chalk.blue('⏳');
        agentStatusText = 'RUNNING';
        agentStatusColor = chalk.blue;
      } else if (isSkipped) {
        agentIcon = chalk.yellow('⏭️');
        agentStatusText = 'SKIPPED';
        agentStatusColor = chalk.yellow;
      } else if (isFailed) {
        agentIcon = chalk.red('❌');
        agentStatusText = 'FAILED';
        agentStatusColor = chalk.red;
      } else if (auditAgent?.status === 'rolled-back') {
        agentIcon = chalk.yellow('🔄');
        agentStatusText = 'ROLLED-BACK';
        agentStatusColor = chalk.yellow;
      } else {
        agentIcon = chalk.gray('⏸️');
        agentStatusText = 'PENDING';
        agentStatusColor = chalk.gray;
      }

      const metricsSuffix = [];
      if (auditAgent) {
        if (auditAgent.total_cost_usd > 0) metricsSuffix.push(`$${auditAgent.total_cost_usd.toFixed(4)}`);
        if (auditAgent.final_duration_ms > 0) metricsSuffix.push(formatDuration(auditAgent.final_duration_ms));
      }

      const suffixStr = metricsSuffix.length > 0 ? chalk.gray(` [${metricsSuffix.join(' | ')}]`) : '';
      const nameDisplay = agent.name.replace(/-/g, ' ');

      console.log(`  ${agentIcon} ${agentStatusColor(nameDisplay.padEnd(20))} ${chalk.bold(agentStatusColor(`[${agentStatusText}]`))}${suffixStr}`);
    }
  }

  // Show deliverable if available
  if (session.targetRepo) {
    const finalReportPath = path.join(session.targetRepo, 'deliverables', 'comprehensive_security_assessment_report.md');
    try {
      if (await fs.pathExists(finalReportPath)) {
        console.log(chalk.cyan('\n' + '-'.repeat(60)));
        console.log(chalk.green(`📄 Final Report: ${finalReportPath}`));
      }
    } catch (error) {}
  }

  // Next recommended action
  const nextAgent = getNextAgent(session);
  console.log(chalk.cyan('\n' + '='.repeat(60)));

  if (nextAgent) {
    console.log(chalk.bold.yellow('👉 NEXT STEP:'));
    console.log(chalk.white(`   Run the next agent: `) + chalk.bold.green(`./dokodemodoor.mjs --run-agent ${nextAgent.name}`));
  } else if (status === 'completed') {
    console.log(chalk.bold.green('🎉 MISSION ACCOMPLISHED!'));
    console.log(chalk.white('   All agents have completed successfully. Review the final report for details.'));
  } else if (status === 'failed') {
    const firstFailed = session.failedAgents[0];
    console.log(chalk.bold.red('🚨 ACTION REQUIRED:'));
    console.log(chalk.white(`   Agent `) + chalk.bold.red(firstFailed) + chalk.white(` failed. Fix the issue or rerun using:`));
    console.log(chalk.bold.yellow(`   ./dokodemodoor.mjs --rerun ${firstFailed}`));
  }
};

// List all available agents
export const listAgents = () => {
  console.log(chalk.cyan('Available Agents:'));

  const phaseNames = Object.keys(PHASES);

  phaseNames.forEach((phaseName, phaseIndex) => {
    const phaseAgents = PHASES[phaseName];
    const phaseDisplayName = phaseName.split('-').map(word =>
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');

    console.log(chalk.yellow(`\nPhase ${phaseIndex + 1} - ${phaseDisplayName}:`));

    phaseAgents.forEach(agentName => {
      const agent = AGENTS[agentName];
      console.log(chalk.white(`  ${agent.name.padEnd(18)} ${agent.displayName}`));
    });
  });
};

// Helper function to get prompt name from agent name
const getPromptName = (agentName) => {
  const mappings = {
    'pre-recon': 'pre-recon-code',
    'recon': 'recon',
    'recon-verify': 'recon-verify',
    'sqli-vuln': 'vuln-sqli',
    'codei-vuln': 'vuln-codei',
    'ssti-vuln': 'vuln-ssti',
    'pathi-vuln': 'vuln-pathi',
    'xss-vuln': 'vuln-xss',
    'auth-vuln': 'vuln-auth',
    'ssrf-vuln': 'vuln-ssrf',
    'authz-vuln': 'vuln-authz',
    'sqli-exploit': 'exploit-sqli',
    'codei-exploit': 'exploit-codei',
    'ssti-exploit': 'exploit-ssti',
    'pathi-exploit': 'exploit-pathi',
    'xss-exploit': 'exploit-xss',
    'auth-exploit': 'exploit-auth',
    'ssrf-exploit': 'exploit-ssrf',
    'authz-exploit': 'exploit-authz',
    'report': 'report-executive'
  };

  return mappings[agentName] || agentName;
};

// Helper function to get time ago for specific agent
const getTimeAgoForAgent = (session, agentName) => {
  // This would need to be implemented based on session checkpoint timestamps
  // For now, just return relative to last activity
  return getTimeAgo(session.lastActivity);
};

// Helper function for time ago calculation
const getTimeAgo = (timestamp) => {
  const now = new Date();
  const past = new Date(timestamp);
  const diffMs = now - past;

  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 60) {
    return `${diffMins}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else {
    return `${diffDays}d ago`;
  }
};
