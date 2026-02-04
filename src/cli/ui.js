import chalk from 'chalk';
import { displaySplashScreen } from '../splash-screen.js';

// Helper function: Display help information
/**
 * [목적] CLI 도움말 출력.
 *
 * [호출자]
 * - dokodemodoor.mjs (help 플래그 처리)
 *
 * [출력 대상]
 * - 표준 출력 콘솔
 *
 * [반환값]
 * - void
 */
export function showHelp() {
  console.log(chalk.cyan.bold('AI Based DokodemoDoor AGENT - for Pentest'));
  console.log(chalk.gray('Automated security assessment tool\n'));

  console.log(chalk.yellow.bold('NORMAL MODE (Creates Sessions):'));
  console.log('  ./dokodemodoor.mjs <WEB_URL> <REPO_PATH> [--config config.yaml]');
  console.log('  ./dokodemodoor.mjs <WEB_URL> <REPO_PATH> --setup-only                     # Setup local repo and create session only\n');

  console.log(chalk.yellow.bold('DEVELOPER MODE (Operates on Existing Sessions):'));
  console.log('  ./dokodemodoor.mjs --run-phase <phase-name> [--session <id>]');
  console.log('  ./dokodemodoor.mjs --run-all [--session <id>]');
  console.log('  ./dokodemodoor.mjs --rollback-to <agent-name> [--session <id>]');
  console.log('  ./dokodemodoor.mjs --rerun <agent-name> [--session <id>]');
  console.log('  ./dokodemodoor.mjs --status [--session <id>]');
  console.log('  ./dokodemodoor.mjs --list-agents');
  console.log('  ./dokodemodoor.mjs --cleanup [session-id]                      # Delete sessions\n');

  console.log(chalk.yellow.bold('OPTIONS:'));
  console.log('  --config <file>      YAML configuration file for authentication and testing parameters');
  console.log('  --session <id>       Target specific session (full UUID or first 8 chars). Skips interactive selection.');
  console.log('  --disable-loader     Disable the animated progress loader (useful when logs interfere with spinner)\n');

  console.log(chalk.yellow.bold('DEVELOPER COMMANDS:'));
  console.log('  --run-phase          Run all agents in a phase (parallel execution for 5x speedup)');
  console.log('  --run-all            Run all remaining agents to completion (parallel execution)');
  console.log('  --rollback-to        Rollback to agent checkpoint and invalidate all subsequent agents');
  console.log('  --rerun              Rerun specific agent in isolation (does NOT affect other agents)');
  console.log('  --status             Show current session status and progress');
  console.log('  --list-agents        List all available agents and phases');
  console.log('  --cleanup            Delete all sessions or specific session by ID\n');

  console.log(chalk.yellow.bold('EXAMPLES:'));
  console.log('  # Normal mode - create new session');
  console.log('  ./dokodemodoor.mjs "https://example.com" "/path/to/local/repo"');
  console.log('  ./dokodemodoor.mjs "https://example.com" "/path/to/local/repo" --config auth.yaml');
  console.log('  ./dokodemodoor.mjs "https://example.com" "/path/to/local/repo" --setup-only  # Setup only\n');

  console.log('  # Developer mode - operate on existing session');
  console.log('  ./dokodemodoor.mjs --status                           # Show session status (interactive)');
  console.log('  ./dokodemodoor.mjs --status --session 2c94c65a        # Show specific session status');
  console.log('  ./dokodemodoor.mjs --run-phase exploitation           # Run entire phase');
  console.log('  ./dokodemodoor.mjs --rerun sqli-vuln --session abc123 # Rerun only sqli-vuln (isolated)');
  console.log('  ./dokodemodoor.mjs --rollback-to recon                # Rollback and invalidate all after recon');
  console.log('  ./dokodemodoor.mjs --cleanup                          # Delete all sessions');
  console.log('  ./dokodemodoor.mjs --cleanup <session-id>             # Delete specific session\n');

  console.log(chalk.yellow.bold('REQUIREMENTS:'));
  console.log('  • WEB_URL must start with http:// or https://');
  console.log('  • REPO_PATH must be an accessible local directory');
  console.log('  • Only test systems you own or have permission to test');
  console.log('  • Developer mode requires existing pentest session\n');

  console.log(chalk.yellow.bold('ENVIRONMENT VARIABLES:'));
  console.log('  PENTEST_MAX_RETRIES    Number of retries for AI agents (default: 3)');
}

// Export the splash screen function for use in main
export { displaySplashScreen };
