#!/usr/bin/env node
import { path, fs, $ } from 'zx';
import chalk from 'chalk';
import dotenv from 'dotenv';

dotenv.config();

// Config and Tools
import { loadConfig } from './src/config/config-loader.js';

// Session and Checkpoints
import { createSession, AGENTS, markAgentRunning, markAgentCompleted, markAgentFailed } from './src/session-manager.js';
import { getGitCommitHash } from './src/checkpoint-manager.js';

// AI and Prompts
import { runAgentPromptWithRetry } from './src/ai/agent-executor.js';
import { loadPrompt } from './src/prompts/prompt-manager.js';

// Phase: RE Analysis
import { executeREPhases } from './src/phases/re-analysis.js';

// Utils
import { Timer } from './src/utils/metrics.js';
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
 * [목적] RE 작업 디렉토리 초기화 (deliverables 저장용).
 */
async function setupREWorkspace(binaryPath) {
  const binaryName = path.basename(binaryPath, path.extname(binaryPath));
  const workDir = path.join(process.cwd(), 'repos', `re-${binaryName}`);

  await fs.ensureDir(workDir);
  await fs.ensureDir(path.join(workDir, 'deliverables'));

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

function parseArgs(argv) {
  let args = argv.slice(2);
  if (args[0] && args[0].includes('re-scanner.mjs')) {
    args = args.slice(1);
  }

  const parsed = { binaryPath: null, configPath: null, phase: null, agent: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      parsed.configPath = args[++i];
    } else if (args[i] === '--phase' && args[i + 1]) {
      parsed.phase = args[++i];
    } else if (args[i] === '--agent' && args[i + 1]) {
      parsed.agent = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(chalk.cyan.bold('DokodemoDoor Reverse Engineering Scanner'));
      console.log(chalk.gray(`
Usage: node re-scanner.mjs <binary_path> [options]

Arguments:
  binary_path              Path to the target binary (PE/ELF/Mach-O)

Options:
  --config <path>          YAML config file with RE settings and MCP servers
  --phase <name>           Run specific phase only (re-inventory, re-static-analysis, etc.)
  --agent <name>           Run specific agent only (re-inventory, re-static, etc.)
  --help, -h               Show this help

Examples:
  node re-scanner.mjs "/path/to/binary" --config configs/profile/sample-re.yaml
  node re-scanner.mjs "/path/to/binary" --agent re-inventory
  node re-scanner.mjs "./targets/app.elf" --phase re-static-analysis
`));
      process.exit(0);
    } else if (!parsed.binaryPath) {
      parsed.binaryPath = args[i];
    }
  }

  return parsed;
}

async function main() {
  const { binaryPath, configPath, phase, agent } = parseArgs(process.argv);

  if (!binaryPath) {
    console.log(chalk.red('❌ Missing binary path.'));
    console.log(chalk.gray('Usage: node re-scanner.mjs <binary_path> [--config <path>]'));
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

  // 4. Prepare RE variables for prompt interpolation
  const reVariables = {
    binaryPath: resolvedBinary,
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
