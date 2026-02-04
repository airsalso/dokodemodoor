#!/usr/bin/env node
import { path, fs, $ } from 'zx';
import chalk from 'chalk';
import dotenv from 'dotenv';

dotenv.config();

// Config and Tools
import { loadConfig } from './src/config/config-loader.js';
import { checkToolAvailability } from './src/tool-checker.js';

// Session and Checkpoints
import { createSession, AGENTS } from './src/session-manager.js';

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

async function main() {
  const args = process.argv.slice(2);
  const webUrl = args[0] || 'http://localhost'; // Default if not provided
  const repoPath = args[1];
  const configPath = args[2] || null;

  if (!repoPath) {
    console.log(chalk.red('❌ Missing repository path.'));
    console.log(chalk.gray('Usage: ./osv-scanner.mjs <target_url> <repo_path> [config_path]'));
    process.exit(1);
  }

  await validateRepoPath(repoPath);

  const totalTimer = new Timer('osv-total-execution');
  await displaySplashScreen();

  console.log(chalk.magenta.bold('🚀 DOKODEMODOOR OSV STANDALONE SCANNER'));
  console.log(chalk.cyan(`🎯 Target: ${webUrl}`));
  console.log(chalk.cyan(`📁 Source: ${repoPath}`));

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
    const result = await executeOsvAnalysisPhase(session, runAgentPromptWithRetry, loadPrompt);

    if (result.success) {
      console.log(chalk.green.bold('\n✨ OSV analysis completed successfully!'));
      console.log(chalk.gray(`   Deliverables saved in: ${path.join(sourceDir, 'deliverables')}`));
    }
  } catch (error) {
    await logError(error, 'OSV Analysis');
    process.exit(1);
  }

  const duration = totalTimer.stop();
  console.log(chalk.cyan(`\n⏱️  Total execution time: ${duration / 1000}s`));
}

main().catch(async (error) => {
  console.error(chalk.red('\n💥 Fatal Error:'), error);
  process.exit(1);
});
