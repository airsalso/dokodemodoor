#!/usr/bin/env node
import { path, fs, $ } from 'zx';
import chalk from 'chalk';
import dotenv from 'dotenv';

dotenv.config();

// Config and Tools
import { loadConfig } from './src/config/config-loader.js';

// Session and Checkpoints
import { createSession, getSession, updateSession, deleteSession, AGENTS, RE_PHASES, RE_PHASE_ORDER } from './src/session-manager.js';
import { promptConfirmation } from './src/cli/prompts.js';
import { getGitCommitHash } from './src/checkpoint-manager.js';
import { DOKODEMODOOR_ROOT } from './src/audit/utils.js';

// AI and Prompts
import { runAgentPromptWithRetry } from './src/ai/agent-executor.js';
import { loadPrompt } from './src/prompts/prompt-manager.js';

// Phase: RE Analysis
import { executeREPhases } from './src/phases/re-analysis.js';

// Utils
import { Timer } from './src/utils/metrics.js';
import { getLocalISOString } from './src/utils/time-utils.js';
import { displaySplashScreen } from './src/cli/ui.js';

// Error Handling
import { PentestError, logError } from './src/error-handling.js';

$.timeout = 0;

let activeSessionId = null;

/**
 * [목적] 시그널 수신 시 세션 상태 정리.
 */
const cleanupAndExit = async (signal) => {
  console.log(chalk.yellow(`\n⚠️ Received ${signal}, cleaning up session...`));
  if (activeSessionId) {
    try {
      const { getSession, updateSession } = await import('./src/session-manager.js');
      const { getLocalISOString } = await import('./src/utils/time-utils.js');

      const session = await getSession(activeSessionId);
      if (session) {
        const runningAgents = session.runningAgents || [];
        const failedAgents = new Set([...(session.failedAgents || []), ...runningAgents]);

        await updateSession(activeSessionId, {
          status: 'interrupted',
          lastActivity: getLocalISOString(),
          runningAgents: [],
          failedAgents: Array.from(failedAgents)
        });
        console.log(chalk.gray(`    📝 Session ${activeSessionId.substring(0, 8)} cleaned up (running -> failed)`));
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }
  process.exit(0);
};

process.on('SIGINT', () => cleanupAndExit('SIGINT'));
process.on('SIGTERM', () => cleanupAndExit('SIGTERM'));

/**
 * [목적] 바이너리 경로 유효성 검증.
 */
async function validateBinaryPath(binaryPath) {
  const resolved = path.resolve(binaryPath);
  if (!await fs.pathExists(resolved)) {
    console.log(chalk.red(`❌ Binary not found: ${resolved}`));
    process.exit(1);
  }
  return resolved;
}

/**
 * [목적] RE 작업 디렉토리 초기화 (deliverables 저장용) 및 바이너리를 워크스페이스에 복사.
 * 바이너리를 복사해 두면 MCP bash/파일 도구의 project root 샌드박스 안에서 접근 가능해진다.
 */
async function setupREWorkspace(binaryPath) {
  const binaryName = path.basename(binaryPath, path.extname(binaryPath));
  const workDir = path.join(process.cwd(), 'repos', `re-${binaryName}`);

  await fs.ensureDir(workDir);
  await fs.ensureDir(path.join(workDir, 'deliverables'));

  // 바이너리를 워크스페이스에 복사 (MCP 샌드박스는 project root = workDir 만 허용)
  const destBinary = path.join(workDir, path.basename(binaryPath));
  const needCopy = !(await fs.pathExists(destBinary)) ||
    (await fs.stat(binaryPath)).mtimeMs > (await fs.stat(destBinary)).mtimeMs;
  if (needCopy) {
    await fs.copy(binaryPath, destBinary);
  }

  // git repo 초기화 (체크포인트용)
  const gitDir = path.join(workDir, '.git');
  if (!await fs.pathExists(gitDir)) {
    await $`git -C ${workDir} init`;
    // 초기 커밋
    await fs.writeFile(path.join(workDir, '.gitkeep'), '');
    await $`git -C ${workDir} add .`;
    await $`git -C ${workDir} commit -m ${'Initial RE workspace'}`;
  }

  return workDir;
}

/** RE 세션 여부: webUrl이 URL이 아니거나 targetRepo가 repos/re-* 이면 RE 세션 */
function isRESession(session) {
  const url = session.webUrl || '';
  const repo = session.targetRepo || session.repoPath || '';
  if (url.includes('://')) return false;
  return repo.includes('repos/re-') || path.basename(repo).startsWith('re-');
}

/** RE 파이프라인 기준 진행률 (RE_PHASES 사용) */
function getRESessionStatus(session) {
  const pipelineAgents = new Set(RE_PHASE_ORDER.flatMap(phase => RE_PHASES[phase] || []));
  const totalAgents = pipelineAgents.size;
  const completedCount = new Set([
    ...(session.completedAgents || []),
    ...(session.skippedAgents || [])
  ].filter(name => pipelineAgents.has(name))).size;
  const failedCount = (session.failedAgents || []).filter(name => pipelineAgents.has(name)).length;
  const isComplete = completedCount === totalAgents;
  let status = 'in-progress';
  if ((session.runningAgents || []).length > 0) status = 'running';
  else if (failedCount > 0) status = 'failed';
  else if (isComplete) status = 'completed';
  return {
    status,
    completedCount,
    totalAgents,
    failedCount,
    completionPercentage: totalAgents ? Math.round((completedCount / totalAgents) * 100) : 0,
    isPipelineComplete: isComplete
  };
}

function parseArgs(argv) {
  let args = argv.slice(2);
  if (args[0] && args[0].includes('re-scanner.mjs')) {
    args = args.slice(1);
  }

  const parsed = { binaryPath: null, configPath: null, phase: null, agent: null, status: false, statusSessionId: null, cleanup: false, cleanupSessionId: null, markInterrupted: false, markInterruptedSessionId: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      parsed.configPath = args[++i];
    } else if (args[i] === '--phase' && args[i + 1]) {
      parsed.phase = args[++i];
    } else if (args[i] === '--agent' && args[i + 1]) {
      parsed.agent = args[++i];
    } else if (args[i] === '--status') {
      parsed.status = true;
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        parsed.statusSessionId = args[++i];
      }
    } else if (args[i] === '--cleanup') {
      parsed.cleanup = true;
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        parsed.cleanupSessionId = args[++i];
      }
    } else if (args[i] === '--mark-interrupted') {
      parsed.markInterrupted = true;
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        parsed.markInterruptedSessionId = args[++i];
      }
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(chalk.cyan.bold('DokodemoDoor Reverse Engineering Scanner'));
      console.log(chalk.gray(`
Usage: node re-scanner.mjs <binary_path> [options]
       node re-scanner.mjs --status [session_id]
       node re-scanner.mjs --cleanup [session_id]
       node re-scanner.mjs --mark-interrupted [session_id]

Arguments:
  binary_path              Path to the target binary (PE/ELF/Mach-O)

Options:
  --config <path>          YAML config file with RE settings and MCP servers
  --phase <name>           Run specific phase only (re-inventory, re-static-analysis, etc.)
  --agent <name>           Run specific agent only (re-inventory, re-static, etc.)
  --status [session_id]   Show RE session status (optional: session ID or prefix)
  --cleanup [session_id]  Delete RE session(s). With ID: delete that session; without: delete all RE sessions (with confirmation).
  --mark-interrupted [session_id]  Mark RE session(s) as interrupted (e.g. after process was SIGKILLed). With ID: that session; without: all RE sessions with running agents.
  --help, -h               Show this help

Examples:
  node re-scanner.mjs "/path/to/binary" --config configs/profile/sample-re.yaml
  node re-scanner.mjs "/path/to/binary" --agent re-inventory
  node re-scanner.mjs --status
  node re-scanner.mjs --status a1b2c3d4
  node re-scanner.mjs --cleanup 13e0904d
  node re-scanner.mjs --cleanup
  node re-scanner.mjs --mark-interrupted
  node re-scanner.mjs --mark-interrupted 13e0904d
`));
      process.exit(0);
    } else if (!parsed.binaryPath && args[i] !== '--status' && args[i] !== '--cleanup' && args[i] !== '--mark-interrupted') {
      parsed.binaryPath = args[i];
    }
  }

  return parsed;
}

const STORE_FILE = path.join(DOKODEMODOOR_ROOT, '.dokodemodoor-store.json');

/** RE 세션 목록 로드 (스토어에서 RE만 필터) */
async function loadRESessions() {
  if (!await fs.pathExists(STORE_FILE)) {
    return [];
  }
  const content = await fs.readFile(STORE_FILE, 'utf8');
  const store = JSON.parse(content || '{}');
  const sessions = Object.values(store.sessions || {});
  return sessions.filter(isRESession);
}

/** RE 세션 상태 출력 (한 개 또는 전체) */
async function showREStatus(sessionIdOrNull) {
  const reSessions = await loadRESessions();
  if (reSessions.length === 0) {
    console.log(chalk.yellow('No RE sessions found. Run re-scanner.mjs with a binary path first.'));
    return;
  }

  let sessionsToShow = reSessions;
  if (sessionIdOrNull) {
    const match = reSessions.find(s => s.id === sessionIdOrNull || s.id.startsWith(sessionIdOrNull));
    if (!match) {
      console.log(chalk.red(`Session not found: ${sessionIdOrNull}`));
      console.log(chalk.gray('Available RE sessions:'));
      reSessions.forEach(s => console.log(chalk.gray(`  ${s.id.substring(0, 8)}  ${s.webUrl}`)));
      process.exit(1);
    }
    sessionsToShow = [match];
  }

  for (const session of sessionsToShow) {
    const st = getRESessionStatus(session);
    const workspace = session.targetRepo || session.repoPath || '';
    const deliverablesDir = path.join(workspace, 'deliverables');

    console.log('\n' + chalk.bold.cyan('='.repeat(60)));
    console.log(chalk.bold.white('  🔬 RE SCANNER STATUS'));
    console.log(chalk.bold.cyan('='.repeat(60)));
    console.log(`${chalk.bold('Binary  :')} ${chalk.blue(session.webUrl)}`);
    console.log(`${chalk.bold('Workspace:')} ${chalk.gray(workspace)}`);
    console.log(`${chalk.bold('Session ID:')} ${chalk.gray(session.id)}`);
    const statusIcon = st.status === 'completed' ? '✅' : st.status === 'failed' ? '❌' : '🔄';
    const statusColor = st.status === 'completed' ? chalk.green : st.status === 'failed' ? chalk.red : chalk.blue;
    const barW = 24;
    const filled = Math.round((st.completionPercentage / 100) * barW);
    const bar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(barW - filled));
    console.log(`${chalk.bold('Progress:')} ${statusColor(`[${statusIcon} ${st.status.toUpperCase()}]`)} ${bar} ${st.completionPercentage}% (${st.completedCount}/${st.totalAgents} agents)`);
    if (session.lastActivity) {
      console.log(`${chalk.bold('Updated :')} ${chalk.gray(session.lastActivity)}`);
    }
    console.log(chalk.cyan('-'.repeat(60)));

    for (const phaseName of RE_PHASE_ORDER) {
      const agents = RE_PHASES[phaseName] || [];
      const label = phaseName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      console.log(`\n${chalk.bold(label)}`);
      for (const agentName of agents) {
        const done = (session.completedAgents || []).includes(agentName);
        const skip = (session.skippedAgents || []).includes(agentName);
        const fail = (session.failedAgents || []).includes(agentName);
        const run = (session.runningAgents || []).includes(agentName);
        const icon = done ? chalk.green('✅') : run ? chalk.blue('⏳') : skip ? chalk.yellow('⏭️') : fail ? chalk.red('❌') : chalk.gray('⏸️');
        const text = done ? 'COMPLETED' : run ? 'RUNNING' : skip ? 'SKIPPED' : fail ? 'FAILED' : 'PENDING';
        console.log(`  ${icon} ${agentName}  ${chalk.gray(text)}`);
      }
    }

    if (await fs.pathExists(deliverablesDir)) {
      const files = await fs.readdir(deliverablesDir);
      console.log(chalk.cyan('\n' + '-'.repeat(60)));
      console.log(chalk.bold('Deliverables:'));
      files.forEach(f => console.log(chalk.gray(`  ${path.join(deliverablesDir, f)}`)));
    }
    console.log('');
  }
}

/** 삭제된 세션 표시용 라벨 (RE는 경로, 웹은 hostname) */
function sessionLabel(session) {
  const url = session.webUrl || '';
  if (url.includes('://')) {
    try {
      return new URL(url).hostname;
    } catch {
      return url.replace(/^.*[/\\]/, '') || session.id.substring(0, 8);
    }
  }
  return url.replace(/^.*[/\\]/, '') || session.id.substring(0, 8);
}

/** RE 세션을 interrupted 로 마킹 (SIGKILL 등으로 프로세스가 죽었을 때, 별도 프로세스에서 호출) */
async function runREMarkInterrupted(sessionIdOrNull) {
  const reSessions = await loadRESessions();
  let toUpdate = [];
  if (sessionIdOrNull) {
    const match = reSessions.find(s => s.id === sessionIdOrNull || s.id.startsWith(sessionIdOrNull));
    if (!match) {
      console.log(chalk.red(`Session not found: ${sessionIdOrNull}`));
      process.exit(1);
    }
    toUpdate = [match];
  } else {
    toUpdate = reSessions.filter(s => (s.runningAgents || []).length > 0);
  }

  if (toUpdate.length === 0) {
    console.log(chalk.gray('No RE session(s) to mark as interrupted.'));
    return;
  }

  for (const s of toUpdate) {
    const running = s.runningAgents || [];
    const failedAgents = new Set([...(s.failedAgents || []), ...running]);
    await updateSession(s.id, {
      status: 'interrupted',
      lastActivity: getLocalISOString(),
      runningAgents: [],
      failedAgents: Array.from(failedAgents)
    });
    console.log(chalk.green(`✅ Marked session ${s.id.substring(0, 8)}... as interrupted (was running: ${running.join(', ') || 'none'})`));
  }
}

/** RE 세션 정리: 한 개 삭제 또는 전체 RE 세션 삭제 */
async function runRECleanup(sessionIdOrNull) {
  if (sessionIdOrNull) {
    try {
      const deleted = await deleteSession(sessionIdOrNull);
      console.log(chalk.green(`✅ Deleted session ${deleted.id.substring(0, 8)}... (${sessionLabel(deleted)})`));
    } catch (error) {
      console.log(chalk.red(`❌ Cleanup failed: ${error.message}`));
      if (error.context?.sessionId) {
        const reSessions = await loadRESessions();
        if (reSessions.length > 0) {
          console.log(chalk.gray('RE sessions: ' + reSessions.map(s => s.id.substring(0, 8)).join(', ')));
        }
      }
      process.exit(1);
    }
    return;
  }

  const reSessions = await loadRESessions();
  if (reSessions.length === 0) {
    console.log(chalk.yellow('No RE sessions to delete.'));
    return;
  }
  const confirmed = await promptConfirmation(
    chalk.yellow(`⚠️  Delete ${reSessions.length} RE session(s)? (y/N):`)
  );
  if (!confirmed) {
    console.log(chalk.gray('Cleanup cancelled.'));
    return;
  }
  for (const s of reSessions) {
    try {
      await deleteSession(s.id);
      console.log(chalk.green(`✅ Deleted ${s.id.substring(0, 8)}... (${sessionLabel(s)})`));
    } catch (e) {
      console.log(chalk.yellow(`⚠️  Failed to delete ${s.id.substring(0, 8)}: ${e.message}`));
    }
  }
}

async function main() {
  const { binaryPath, configPath, phase, agent, status, statusSessionId, cleanup, cleanupSessionId, markInterrupted, markInterruptedSessionId } = parseArgs(process.argv);

  if (markInterrupted) {
    await runREMarkInterrupted(markInterruptedSessionId);
    return;
  }

  if (cleanup) {
    await runRECleanup(cleanupSessionId);
    return;
  }

  if (status) {
    await showREStatus(statusSessionId);
    return;
  }

  if (!binaryPath) {
    console.log(chalk.red('❌ Missing binary path.'));
    console.log(chalk.gray('Usage: node re-scanner.mjs <binary_path> [--config <path>]'));
    console.log(chalk.gray('       node re-scanner.mjs --status [session_id]'));
    console.log(chalk.gray('       node re-scanner.mjs --cleanup [session_id]'));
    console.log(chalk.gray('       node re-scanner.mjs --mark-interrupted [session_id]'));
    console.log(chalk.gray('       node re-scanner.mjs --help'));
    process.exit(1);
  }

  const resolvedBinary = await validateBinaryPath(binaryPath);

  const totalTimer = new Timer('re-total-execution');
  await displaySplashScreen();

  console.log(chalk.magenta.bold('🔬 DOKODEMODOOR REVERSE ENGINEERING SCANNER'));
  console.log(chalk.cyan(`📦 Binary: ${resolvedBinary}`));

  // 1. Setup workspace
  const sourceDir = await setupREWorkspace(resolvedBinary);
  console.log(chalk.gray(`📂 Workspace: ${sourceDir}`));

  // 2. Create session (webUrl에 바이너리 경로를 사용)
  const session = await createSession(resolvedBinary, sourceDir, configPath, sourceDir);
  activeSessionId = session.id;
  console.log(chalk.blue(`📝 Session created: ${session.id.substring(0, 8)}...`));

  // 3. Load config
  let config = null;
  let reConfig = null;
  if (configPath) {
    const configResult = await loadConfig(configPath);
    config = configResult.config;
    session.config = config;
    reConfig = config?.reverse_engineering || null;

    if (reConfig) {
      console.log(chalk.gray(`   Analysis focus: ${reConfig.analysis_focus?.join(', ') || 'all'}`));
      if (reConfig.symbols_path) console.log(chalk.gray(`   Symbols: ${reConfig.symbols_path}`));
    }
  }

  // 4. Prepare RE variables for prompt interpolation (바이너리 경로는 워크스페이스 내 경로로 전달해 MCP 샌드박스 접근 가능)
  const binaryInWorkspace = path.join(sourceDir, path.basename(resolvedBinary));
  const reVariables = {
    binaryPath: binaryInWorkspace,
    symbolsPath: reConfig?.symbols_path || '',
    processName: reConfig?.process_name || path.basename(resolvedBinary, path.extname(resolvedBinary)),
    analysisFocus: reConfig?.analysis_focus?.join(', ') || 'network, authentication, cryptography'
  };

  // 5. Run RE Analysis pipeline
  try {
    const result = await executeREPhases(session, runAgentPromptWithRetry, loadPrompt, reVariables, {
      targetPhase: phase,
      targetAgent: agent
    });

    if (result.success) {
      console.log(chalk.green.bold('\n✨ Reverse engineering analysis completed!'));
      console.log(chalk.gray(`   Deliverables saved in: ${path.join(sourceDir, 'deliverables')}`));

      if (result.completedAgents?.length > 0) {
        console.log(chalk.gray(`   Completed agents: ${result.completedAgents.join(', ')}`));
      }
    } else {
      console.log(chalk.yellow('\n⚠️ RE analysis completed with issues.'));
      if (result.failedAgents?.length > 0) {
        console.log(chalk.red(`   Failed agents: ${result.failedAgents.join(', ')}`));
      }
    }
  } catch (error) {
    await logError(error, 'RE Analysis');
    process.exit(1);
  }

  const duration = totalTimer.stop();
  console.log(chalk.cyan(`\n⏱️  Total execution time: ${duration / 1000}s`));
}

main().catch(async (error) => {
  console.error(chalk.red('\n💥 Fatal Error:'), error.message);
  if (error.stack) console.error(chalk.gray(error.stack));
  process.exit(1);
});
