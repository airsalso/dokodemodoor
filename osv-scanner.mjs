#!/usr/bin/env node
import { path, fs, $ } from 'zx';
import chalk from 'chalk';
import dotenv from 'dotenv';

dotenv.config();

// Config and Tools
import { loadConfig } from './src/config/config-loader.js';
import { checkToolAvailability } from './src/tool-checker.js';

// Session and Checkpoints
import { createSession, deleteSession, updateSession, markAgentRunning, markAgentCompleted, markAgentFailed } from './src/session-manager.js';
import { getLocalISOString } from './src/utils/time-utils.js';
import { getGitCommitHash } from './src/checkpoint-manager.js';
import { DOKODEMODOOR_ROOT } from './src/audit/utils.js';
import { promptConfirmation } from './src/cli/prompts.js';

// Setup and Deliverables
import { setupLocalRepo } from './src/setup/environment.js';

// AI and Prompts
import { runAgentPromptWithRetry } from './src/ai/agent-executor.js';
import { loadPrompt } from './src/prompts/prompt-manager.js';

// Phase: OSV Analysis
import { executeOsvAnalysisPhase } from './src/phases/osv-analysis.js';

// Utils
import { Timer, displayTimingSummary } from './src/utils/metrics.js';
import { displaySplashScreen } from './src/cli/ui.js';
import { validateRepoPath } from './src/cli/input-validator.js';

// Error Handling
import { PentestError, logError } from './src/error-handling.js';

$.timeout = 0;

// Track active session globally for signal handlers
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

const STORE_FILE = path.join(DOKODEMODOOR_ROOT, '.dokodemodoor-store.json');

/** OSV 세션 여부: completed/failed/skipped/running 에 osv-analysis 만 있는 세션 */
function isOSVSession(session) {
  const agents = new Set([
    ...(session.completedAgents || []),
    ...(session.failedAgents || []),
    ...(session.skippedAgents || []),
    ...(session.runningAgents || [])
  ]);
  return agents.size === 1 && agents.has('osv-analysis');
}

/** OSV 세션 목록 로드 */
async function loadOSVSessions() {
  if (!await fs.pathExists(STORE_FILE)) {
    return [];
  }
  const content = await fs.readFile(STORE_FILE, 'utf8');
  const store = JSON.parse(content || '{}');
  const sessions = Object.values(store.sessions || {});
  return sessions.filter(isOSVSession);
}

/** OSV 세션 상태 (에이전트 1개) */
function getOSVSessionStatus(session) {
  const completed = (session.completedAgents || []).includes('osv-analysis');
  const failed = (session.failedAgents || []).includes('osv-analysis');
  const running = (session.runningAgents || []).includes('osv-analysis');
  let status = 'in-progress';
  if (running) status = 'running';
  else if (failed) status = 'failed';
  else if (completed) status = 'completed';
  return {
    status,
    completionPercentage: completed ? 100 : (failed ? 0 : 0)
  };
}

/** OSV 세션 상태 출력 */
async function showOSVStatus(sessionIdOrNull) {
  const osvSessions = await loadOSVSessions();
  if (osvSessions.length === 0) {
    console.log(chalk.yellow('No OSV sessions found. Run osv-scanner.mjs with a repo path first.'));
    return;
  }

  let sessionsToShow = osvSessions;
  if (sessionIdOrNull) {
    const match = osvSessions.find(s => s.id === sessionIdOrNull || s.id.startsWith(sessionIdOrNull));
    if (!match) {
      console.log(chalk.red(`Session not found: ${sessionIdOrNull}`));
      console.log(chalk.gray('Available OSV sessions:'));
      osvSessions.forEach(s => console.log(chalk.gray(`  ${s.id.substring(0, 8)}  ${s.webUrl}  ${s.repoPath || s.targetRepo}`)));
      process.exit(1);
    }
    sessionsToShow = [match];
  }

  for (const session of sessionsToShow) {
    const st = getOSVSessionStatus(session);
    const workspace = session.targetRepo || session.repoPath || '';
    const deliverablesDir = path.join(workspace, 'deliverables');

    console.log('\n' + chalk.bold.cyan('='.repeat(60)));
    console.log(chalk.bold.white('  🚀 OSV SCANNER STATUS'));
    console.log(chalk.bold.cyan('='.repeat(60)));
    console.log(`${chalk.bold('Target  :')} ${chalk.blue(session.webUrl)}`);
    console.log(`${chalk.bold('Repo    :')} ${chalk.gray(workspace)}`);
    console.log(`${chalk.bold('Session ID:')} ${chalk.gray(session.id)}`);
    const statusIcon = st.status === 'completed' ? '✅' : st.status === 'failed' ? '❌' : '🔄';
    const statusColor = st.status === 'completed' ? chalk.green : st.status === 'failed' ? chalk.red : chalk.blue;
    console.log(`${chalk.bold('Status  :')} ${statusColor(`[${statusIcon} ${st.status.toUpperCase()}]`)} ${st.completionPercentage}%`);
    if (session.lastActivity) {
      console.log(`${chalk.bold('Updated :')} ${chalk.gray(session.lastActivity)}`);
    }
    console.log(chalk.cyan('-'.repeat(60)));
    console.log(`${chalk.bold('Agent   :')} osv-analysis  ${st.status === 'completed' ? chalk.green('COMPLETED') : st.status === 'failed' ? chalk.red('FAILED') : chalk.gray('PENDING/RUNNING')}`);
    if (await fs.pathExists(deliverablesDir)) {
      const files = await fs.readdir(deliverablesDir);
      console.log(chalk.bold('\nDeliverables:'));
      files.filter(f => f.includes('osv')).forEach(f => console.log(chalk.gray(`  ${path.join(deliverablesDir, f)}`)));
    }
    console.log('');
  }
}

/** 삭제된 세션 표시용 라벨 */
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

/** OSV 세션을 interrupted 로 마킹 (SIGKILL 등으로 프로세스가 죽었을 때, 별도 프로세스에서 호출) */
async function runOSVMarkInterrupted(sessionIdOrNull) {
  const osvSessions = await loadOSVSessions();
  let toUpdate = [];
  if (sessionIdOrNull) {
    const match = osvSessions.find(s => s.id === sessionIdOrNull || s.id.startsWith(sessionIdOrNull));
    if (!match) {
      console.log(chalk.red(`Session not found: ${sessionIdOrNull}`));
      process.exit(1);
    }
    toUpdate = [match];
  } else {
    toUpdate = osvSessions.filter(s => (s.runningAgents || []).length > 0);
  }

  if (toUpdate.length === 0) {
    console.log(chalk.gray('No OSV session(s) to mark as interrupted.'));
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

/** OSV 세션 정리 */
async function runOSVCleanup(sessionIdOrNull) {
  if (sessionIdOrNull) {
    try {
      const deleted = await deleteSession(sessionIdOrNull);
      console.log(chalk.green(`✅ Deleted session ${deleted.id.substring(0, 8)}... (${sessionLabel(deleted)})`));
    } catch (error) {
      console.log(chalk.red(`❌ Cleanup failed: ${error.message}`));
      const osvSessions = await loadOSVSessions();
      if (osvSessions.length > 0) {
        console.log(chalk.gray('OSV sessions: ' + osvSessions.map(s => s.id.substring(0, 8)).join(', ')));
      }
      process.exit(1);
    }
    return;
  }

  const osvSessions = await loadOSVSessions();
  if (osvSessions.length === 0) {
    console.log(chalk.yellow('No OSV sessions to delete.'));
    return;
  }
  const confirmed = await promptConfirmation(
    chalk.yellow(`⚠️  Delete ${osvSessions.length} OSV session(s)? (y/N):`)
  );
  if (!confirmed) {
    console.log(chalk.gray('Cleanup cancelled.'));
    return;
  }
  for (const s of osvSessions) {
    try {
      await deleteSession(s.id);
      console.log(chalk.green(`✅ Deleted ${s.id.substring(0, 8)}... (${sessionLabel(s)})`));
    } catch (e) {
      console.log(chalk.yellow(`⚠️  Failed to delete ${s.id.substring(0, 8)}: ${e.message}`));
    }
  }
}

function parseArgs(argv) {
  let args = argv.slice(2);
  if (args[0] && args[0].includes('osv-scanner.mjs')) {
    args = args.slice(1);
  }

  const parsed = { repoPath: null, webUrl: null, configPath: null, status: false, statusSessionId: null, cleanup: false, cleanupSessionId: null, markInterrupted: false, markInterruptedSessionId: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--status') {
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
      console.log(chalk.cyan.bold('DokodemoDoor OSV Standalone Scanner'));
      console.log(chalk.gray(`
Usage: node osv-scanner.mjs <repo_path> [target_url] [config_path]
       node osv-scanner.mjs --status [session_id]
       node osv-scanner.mjs --cleanup [session_id]
       node osv-scanner.mjs --mark-interrupted [session_id]

Arguments:
  repo_path                Path to the target repository (for scan)
  target_url               Optional target URL (default: http://localhost)
  config_path              Optional config file path

Options:
  --status [session_id]         Show OSV session status (optional: session ID or prefix)
  --cleanup [session_id]        Delete OSV session(s). With ID: delete that session; without: delete all OSV sessions (with confirmation).
  --mark-interrupted [session_id]  Mark running OSV session(s) as interrupted (e.g. after SIGKILL from frontend STOP).
  --help, -h                     Show this help

Examples:
  node osv-scanner.mjs /path/to/repo
  node osv-scanner.mjs /path/to/repo http://localhost:3000 configs/profile/my.yaml
  node osv-scanner.mjs --status
  node osv-scanner.mjs --status a1b2c3d4
  node osv-scanner.mjs --cleanup a1b2c3d4
  node osv-scanner.mjs --cleanup
  node osv-scanner.mjs --mark-interrupted
  node osv-scanner.mjs --mark-interrupted a1b2c3d4
`));
      process.exit(0);
    } else if (!parsed.repoPath && !parsed.status && !parsed.cleanup && !parsed.markInterrupted) {
      parsed.repoPath = args[i];
    } else if (parsed.repoPath && parsed.webUrl === null && args[i] && !args[i].startsWith('--')) {
      parsed.webUrl = args[i];
    } else if (parsed.repoPath && parsed.webUrl !== null && parsed.configPath === null && args[i] && !args[i].startsWith('--')) {
      parsed.configPath = args[i];
    }
  }

  if (parsed.webUrl === null && parsed.repoPath) {
    parsed.webUrl = 'http://localhost';
  }
  return parsed;
}

async function main() {
  const { repoPath, webUrl, configPath, status, statusSessionId, cleanup, cleanupSessionId, markInterrupted, markInterruptedSessionId } = parseArgs(process.argv);

  if (cleanup) {
    await runOSVCleanup(cleanupSessionId);
    return;
  }

  if (markInterrupted) {
    await runOSVMarkInterrupted(markInterruptedSessionId);
    return;
  }

  if (status) {
    await showOSVStatus(statusSessionId);
    return;
  }

  if (!repoPath) {
    console.log(chalk.red('❌ Missing repository path.'));
    console.log(chalk.gray('Usage: node osv-scanner.mjs <repo_path> [target_url] [config_path]'));
    console.log(chalk.gray('       node osv-scanner.mjs --status [session_id]'));
    console.log(chalk.gray('       node osv-scanner.mjs --cleanup [session_id]'));
    console.log(chalk.gray('       node osv-scanner.mjs --mark-interrupted [session_id]'));
    process.exit(1);
  }

  await validateRepoPath(repoPath);

  const totalTimer = new Timer('osv-total-execution');
  await displaySplashScreen();

  console.log(chalk.magenta.bold('🚀 DOKODEMODOOR OSV STANDALONE SCANNER'));
  console.log(chalk.cyan(`📁 Source: ${repoPath}`));
  if (webUrl && webUrl !== 'http://localhost') console.log(chalk.cyan(`🎯 Target URL: ${webUrl}`));

  // 1. Setup Repository
  let sourceDir;
  try {
    sourceDir = await setupLocalRepo(repoPath);
  } catch (error) {
    console.log(chalk.red(`❌ Setup failed: ${error.message}`));
    process.exit(1);
  }

  // 2. Create Session
  const session = await createSession(webUrl, repoPath, configPath, sourceDir);
  activeSessionId = session.id; // Set for global signal handlers
  console.log(chalk.blue(`📝 Session created: ${session.id.substring(0, 8)}...`));

  // 3. Load Config
  let config = null;
  if (configPath) {
    const configResult = await loadConfig(configPath);
    config = configResult.config;
    session.config = config; // Attach to session for phase use
  }

  // 4. Run OSV Analysis
  try {
    // Mark as running for status visibility
    await markAgentRunning(session.id, 'osv-analysis');

    const result = await executeOsvAnalysisPhase(session, runAgentPromptWithRetry, loadPrompt);

    if (result.success) {
      // Mark as completed in session store
      const commitHash = await getGitCommitHash(sourceDir);
      await markAgentCompleted(session.id, 'osv-analysis', commitHash);

      console.log(chalk.green.bold('\n✨ OSV analysis completed successfully!'));
      console.log(chalk.gray(`   Deliverables saved in: ${path.join(sourceDir, 'deliverables')}`));
    } else {
      await markAgentFailed(session.id, 'osv-analysis');
    }
  } catch (error) {
    await markAgentFailed(session.id, 'osv-analysis');
    await logError(error, 'OSV Analysis');
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
