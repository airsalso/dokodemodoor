#!/usr/bin/env node
import { path, fs, $ } from 'zx';
import chalk from 'chalk';
import dotenv from 'dotenv';

dotenv.config();

// Config and Tools
import { loadConfig } from './src/config/config-loader.js';
import { checkToolAvailability } from './src/tool-checker.js';

// Session and Checkpoints
import { createSession, AGENTS, markAgentRunning, markAgentCompleted, markAgentFailed } from './src/session-manager.js';
import { getGitCommitHash } from './src/checkpoint-manager.js';

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

async function main() {
  let args = process.argv.slice(2);
  // If first arg is the script name (from shebang or npx zx), remove it
  if (args[0] && args[0].includes('osv-scanner.mjs')) {
    args = args.slice(1);
  }

  const repoPath = args[0];
  const webUrl = args[1] || 'http://localhost'; // Optional URL
  const configPath = args[2] || null;

  if (!repoPath) {
    console.log(chalk.red('❌ Missing repository path.'));
    console.log(chalk.gray('Usage: ./osv-scanner.mjs <repo_path> [target_url] [config_path]'));
    process.exit(1);
  }

  await validateRepoPath(repoPath);

  const totalTimer = new Timer('osv-total-execution');
  await displaySplashScreen();

  console.log(chalk.magenta.bold('🚀 DOKODEMODOOR OSV STANDALONE SCANNER'));
  console.log(chalk.cyan(`📁 Source: ${repoPath}`));
  if (args[1]) console.log(chalk.cyan(`🎯 Target URL: ${webUrl}`));

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
