import { fs, path } from 'zx';
import chalk from 'chalk';
import { PentestError } from '../error-handling.js';
import {
  AGENTS, RE_PHASES, RE_PHASE_ORDER,
  markAgentRunning, markAgentCompleted, markAgentFailed, markAgentSkipped,
  getSession, checkPrerequisites
} from '../session-manager.js';
import { getGitCommitHash } from '../checkpoint-manager.js';
import { Timer } from '../utils/metrics.js';

/**
 * [목적] RE 파이프라인 전체 실행.
 *
 * [호출자]
 * - re-scanner.mjs
 *
 * [입력 파라미터]
 * - session (object): 세션 객체
 * - runAgentPromptWithRetry (function): 에이전트 실행 함수
 * - loadPrompt (function): 프롬프트 로드 함수
 * - reVariables (object): RE 전용 변수 (binaryPath, symbolsPath, processName, analysisFocus)
 * - options (object): { targetPhase, targetAgent }
 *
 * [반환값]
 * - Promise<object>: { success, completedAgents, failedAgents }
 */
export async function executeREPhases(session, runAgentPromptWithRetry, loadPrompt, reVariables = {}, options = {}) {
  const { targetPhase, targetAgent } = options;
  const sourceDir = session.targetRepo || session.repoPath;

  console.log(chalk.magenta.bold('\n🔬 REVERSE ENGINEERING ANALYSIS PIPELINE'));

  const completedAgents = [];
  const failedAgents = [];

  // 단일 에이전트 실행 모드
  if (targetAgent) {
    if (!AGENTS[targetAgent] || !targetAgent.startsWith('re-')) {
      throw new PentestError(`Unknown RE agent: ${targetAgent}`, 'validation', false);
    }
    console.log(chalk.cyan(`   Running single agent: ${targetAgent}`));
    const result = await runSingleREAgent(session, targetAgent, runAgentPromptWithRetry, loadPrompt, reVariables);
    return {
      success: result.success,
      completedAgents: result.success ? [targetAgent] : [],
      failedAgents: result.success ? [] : [targetAgent]
    };
  }

  // 페이즈별 실행
  const phasesToRun = targetPhase
    ? [targetPhase]
    : RE_PHASE_ORDER;

  for (const phaseName of phasesToRun) {
    const agents = RE_PHASES[phaseName];
    if (!agents) {
      console.log(chalk.yellow(`⚠️ Unknown RE phase: ${phaseName}, skipping`));
      continue;
    }

    console.log(chalk.cyan.bold(`\n📋 RE Phase: ${phaseName}`));

    if (phaseName === 're-dynamic-observation' && agents.length > 1) {
      // 병렬 실행: re-dynamic + re-instrument
      const results = await runParallelREDynamic(session, runAgentPromptWithRetry, loadPrompt, reVariables);
      completedAgents.push(...results.completed);
      failedAgents.push(...results.failed);
    } else {
      // 순차 실행
      for (const agentName of agents) {
        const result = await runSingleREAgent(session, agentName, runAgentPromptWithRetry, loadPrompt, reVariables);
        if (result.success) {
          completedAgents.push(agentName);
        } else {
          failedAgents.push(agentName);
          // 실패해도 계속 진행 (비 치명적)
          console.log(chalk.yellow(`   ⚠️ ${agentName} failed, continuing pipeline...`));
        }
      }
    }
  }

  return {
    success: failedAgents.length === 0,
    completedAgents,
    failedAgents
  };
}

/**
 * [목적] 단일 RE 에이전트 실행.
 *
 * [호출자]
 * - executeREPhases()
 *
 * [반환값]
 * - Promise<object>: { success }
 */
async function runSingleREAgent(session, agentName, runAgentPromptWithRetry, loadPrompt, reVariables) {
  const sourceDir = session.targetRepo || session.repoPath;
  const agent = AGENTS[agentName];
  const timer = new Timer(`re-${agentName}`);

  console.log(chalk.blue(`   🤖 Running ${agent.displayName}...`));

  try {
    // 선행 조건 확인
    try {
      checkPrerequisites(session, agentName);
    } catch (prereqError) {
      console.log(chalk.yellow(`   ⏭️ Skipping ${agentName}: ${prereqError.message}`));
      await markAgentSkipped(session.id, agentName);
      return { success: false };
    }

    await markAgentRunning(session.id, agentName);

    // 프롬프트 로드 (RE 변수 포함)
    const variables = {
      webUrl: session.webUrl,  // RE에서는 바이너리 경로
      repoPath: session.repoPath,
      sourceDir,
      ...reVariables
    };

    const prompt = await loadPrompt(agentName, variables, session.config);

    // 에이전트 실행
    const result = await runAgentPromptWithRetry(
      prompt,
      sourceDir,
      'Read',  // RE 에이전트는 Read 도구 허용
      '',
      agent.displayName,
      agentName,
      chalk.magenta,
      { id: session.id, webUrl: session.webUrl, repoPath: session.repoPath, configFile: session.configFile }
    );

    if (result.success) {
      const commitHash = await getGitCommitHash(sourceDir);
      await markAgentCompleted(session.id, agentName, commitHash);
      const duration = timer.stop();
      console.log(chalk.green(`   ✅ ${agentName} completed (${(duration / 1000).toFixed(1)}s)`));
    } else {
      await markAgentFailed(session.id, agentName);
      timer.stop();
      console.log(chalk.red(`   ❌ ${agentName} failed`));
    }

    return result;
  } catch (error) {
    await markAgentFailed(session.id, agentName);
    timer.stop();
    console.log(chalk.red(`   ❌ ${agentName} error: ${error.message}`));
    return { success: false };
  }
}

/**
 * [목적] RE 동적 관찰 에이전트 병렬 실행 (re-dynamic + re-instrument).
 *
 * [호출자]
 * - executeREPhases()
 *
 * [반환값]
 * - Promise<object>: { completed, failed }
 */
async function runParallelREDynamic(session, runAgentPromptWithRetry, loadPrompt, reVariables) {
  const dynamicAgents = RE_PHASES['re-dynamic-observation'];
  console.log(chalk.cyan(`   🔀 Running ${dynamicAgents.length} agents in parallel...`));

  const results = await Promise.allSettled(
    dynamicAgents.map(agentName =>
      runSingleREAgent(session, agentName, runAgentPromptWithRetry, loadPrompt, reVariables)
    )
  );

  const completed = [];
  const failed = [];

  results.forEach((result, index) => {
    const agentName = dynamicAgents[index];
    if (result.status === 'fulfilled' && result.value.success) {
      completed.push(agentName);
    } else {
      failed.push(agentName);
    }
  });

  console.log(chalk.gray(`   Parallel results: ${completed.length} completed, ${failed.length} failed`));

  return { completed, failed };
}
