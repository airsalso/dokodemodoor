import { $, fs, path } from 'zx';
import chalk from 'chalk';
import { PentestError } from '../error-handling.js';

// Pure function: Setup local repository for testing
/**
 * [목적] 대상 레포 로컬 실행 환경 준비.
 *
 * [호출자]
 * - dokodemodoor.mjs
 *
 * [입력 파라미터]
 * - repoPath (string)
 *
 * [반환값]
 * - Promise<string>
 */
export async function setupLocalRepo(repoPath) {
  try {
    const sourceDir = path.resolve(repoPath);

    // MCP servers are configured via agent executor

    // Initialize git repository if not already initialized and create checkpoint
    try {
      // Check if it's already a git repository
      const isGitRepo = await fs.pathExists(path.join(sourceDir, '.git'));

      if (!isGitRepo) {
        await $`cd ${sourceDir} && git init`;
        console.log(chalk.blue('✅ Git repository initialized'));
      }

      // Configure git for pentest agent
      await $`cd ${sourceDir} && git config user.name "Pentest Agent"`;
      await $`cd ${sourceDir} && git config user.email "agent@localhost"`;

      // Create initial checkpoint
      await $`cd ${sourceDir} && git add -A && git commit -m "Initial checkpoint: Local repository setup" --allow-empty`;
      console.log(chalk.green('✅ Initial checkpoint created'));
    } catch (gitError) {
      console.log(chalk.yellow(`⚠️ Git setup warning: ${gitError.message}`));
      // Non-fatal - continue without Git setup
    }

    // MCP tools (save_deliverable, generate_totp) are now available natively via dokodemodoor-helper MCP server
    // No need to copy bash scripts to target repository

    // Ensure deliverables and outputs directories exist
    // We do NOT empty them here because it would wipe out progress on resumes/restarts
    const deliverablesDir = path.join(sourceDir, 'deliverables');
    const outputsDir = path.join(sourceDir, 'outputs');

    await fs.ensureDir(deliverablesDir);
    await fs.ensureDir(outputsDir);

    const deliverablesExist = (await fs.readdir(deliverablesDir)).length > 0;
    if (deliverablesExist) {
      console.log(chalk.gray(`      ℹ️  Preserving existing deliverables in ${deliverablesDir}`));
    }

    return sourceDir;
  } catch (error) {
    if (error instanceof PentestError) {
      throw error;
    }
    throw new PentestError(
      `Local repository setup failed: ${error.message}`,
      'filesystem',
      false,
      { repoPath, originalError: error.message }
    );
  }
}
