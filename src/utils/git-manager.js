import { $, fs, path } from 'zx';
import chalk from 'chalk';
import os from 'os';

// Global git operations semaphore to prevent index.lock conflicts during parallel execution
/**
 * [목적] git index.lock 충돌 방지를 위한 전역 세마포어.
 *
 * [호출자]
 * - executeGitCommandWithRetry()
 *
 * [출력 대상]
 * - git 작업의 순차 실행 보장
 */
class GitSemaphore {
  constructor() {
    this.queue = [];
    this.running = false;
  }

  async acquire() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.process();
    });
  }

  release() {
    this.running = false;
    this.process();
  }

  process() {
    if (!this.running && this.queue.length > 0) {
      this.running = true;
      const resolve = this.queue.shift();
      resolve();
    }
  }
}

const gitSemaphore = new GitSemaphore();

// Execute git commands with retry logic for index.lock conflicts
/**
 * [목적] git 명령을 재시도/백오프로 안전하게 실행.
 *
 * [호출자]
 * - 체크포인트/커밋/롤백 로직 전반
 *
 * [출력 대상]
 * - zx 실행 결과 반환
 *
 * [입력 파라미터]
 * - commandArgs (array|string)
 * - sourceDir (string)
 * - description (string)
 * - maxRetries (number)
 *
 * [반환값]
 * - Promise<object>
 */
export const executeGitCommandWithRetry = async (commandArgs, sourceDir, description, maxRetries = 5) => {
  await gitSemaphore.acquire();

  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Handle both array and string commands
        let result;
        if (Array.isArray(commandArgs)) {
          // For arrays like ['git', 'status', '--porcelain'], execute parts separately
          const [cmd, ...args] = commandArgs;
          result = await $`cd ${sourceDir} && ${cmd} ${args}`;
        } else {
          // For string commands
          result = await $`cd ${sourceDir} && ${commandArgs}`;
        }
        return result;
      } catch (error) {
        const isLockError = error.message.includes('index.lock') ||
                           error.message.includes('unable to lock') ||
                           error.message.includes('Another git process') ||
                           error.message.includes('fatal: Unable to create') ||
                           error.message.includes('fatal: index file');

        if (isLockError && attempt < maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000; // Exponential backoff: 1s, 2s, 4s, 8s, 16s
          console.log(chalk.yellow(`    ⚠️ Git lock conflict during ${description} (attempt ${attempt}/${maxRetries}). Retrying in ${delay}ms...`));
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }
  } finally {
    gitSemaphore.release();
  }
};

// Pure functions for Git workspace management
/**
 * [목적] deliverables 및 outputs 디렉터리를 보존하면서 작업을 실행.
 * 롤백이나 클린 작업 시 이미 생성된 증거 데이터가 손실되는 것을 방지합니다.
 *
 * [호출자]
 * - cleanWorkspace()
 * - rollbackGitWorkspace()
 * - src/checkpoint-manager.js::rollbackGitToCommit()
 */
export const preserveDeliverables = async (sourceDir, action) => {
  const deliverablesDir = path.join(sourceDir, 'deliverables');
  const outputsDir = path.join(sourceDir, 'outputs');
  const tempDir = path.join(os.tmpdir(), `dokodemodoor_backup_${Date.now()}_${Math.floor(Math.random() * 1000)}`);

  try {
    // 1. 디렉터리 존재 여부 확인 및 백업
    await fs.ensureDir(tempDir);
    const hasDeliverables = await fs.pathExists(deliverablesDir);
    const hasOutputs = await fs.pathExists(outputsDir);

    if (hasDeliverables) {
      await fs.copy(deliverablesDir, path.join(tempDir, 'deliverables'));
    }
    if (hasOutputs) {
      await fs.copy(outputsDir, path.join(tempDir, 'outputs'));
    }

    // 2. 실제 Git 작업 수행 (reset, clean 등)
    await action();

    // 3. 백업된 데이터 복구 (병합 방식)
    if (hasDeliverables) {
      await fs.copy(path.join(tempDir, 'deliverables'), deliverablesDir, { overwrite: true });
    }
    if (hasOutputs) {
      await fs.copy(path.join(tempDir, 'outputs'), outputsDir, { overwrite: true });
    }
  } catch (error) {
    console.log(chalk.yellow(`    ⚠️  Preservation warning: ${error.message}`));
    // 보존에 실패하더라도 원래 작업은 시도
    await action();
  } finally {
    try {
      if (await fs.pathExists(tempDir)) {
        await fs.remove(tempDir);
      }
    } catch (e) {}
  }
};

/**
 * [목적] 워크스페이스 정리(오염된 변경 롤백).
 *
 * [호출자]
 * - createGitCheckpoint()
 *
 * [출력 대상]
 * - { success, hadChanges } 반환
 *
 * [입력 파라미터]
 * - sourceDir (string)
 * - reason (string)
 *
 * [반환값]
 * - Promise<object>
 */
const cleanWorkspace = async (sourceDir, reason = 'clean start') => {
  console.log(chalk.blue(`    🧹 Cleaning workspace for ${reason}`));
  try {
    // Check for uncommitted changes
    const status = await $`cd ${sourceDir} && git status --porcelain`;
    const hasChanges = status.stdout.trim().length > 0;

    if (hasChanges) {
      // Show what we're about to remove
      const changes = status.stdout.trim().split('\n').filter(line => line.length > 0);
      console.log(chalk.yellow(`    🔄 Rolling back workspace for ${reason}`));

      await preserveDeliverables(sourceDir, async () => {
        await $`cd ${sourceDir} && git reset --hard HEAD`;
        await $`cd ${sourceDir} && git clean -fd -e deliverables/ -e outputs/`;
      });

      console.log(chalk.yellow(`    ✅ Rollback completed - removed ${changes.length} contaminated changes:`));
      changes.slice(0, 3).forEach(change => console.log(chalk.gray(`       ${change}`)));
      if (changes.length > 3) {
        console.log(chalk.gray(`       ... and ${changes.length - 3} more files`));
      }
    } else {
      console.log(chalk.blue(`    ✅ Workspace already clean (no changes to remove)`));
    }
    return { success: true, hadChanges: hasChanges };
  } catch (error) {
    console.log(chalk.yellow(`    ⚠️ Workspace cleanup failed: ${error.message}`));
    return { success: false, error };
  }
};

/**
 * [목적] 에이전트 실행 전 체크포인트 커밋 생성.
 *
 * [호출자]
 * - agent-executor runAgentPromptWithRetry()
 *
 * [출력 대상]
 * - 체크포인트 커밋 생성
 *
 * [입력 파라미터]
 * - sourceDir (string)
 * - description (string)
 * - attempt (number)
 *
 * [반환값]
 * - Promise<object>
 */
export const createGitCheckpoint = async (sourceDir, description, attempt) => {
  console.log(chalk.blue(`    📍 Creating checkpoint for ${description} (attempt ${attempt})`));
  try {
    // Only clean workspace on retry attempts (attempt > 1), not on first attempts
    // This preserves deliverables between agents while still cleaning on actual retries
    if (attempt > 1) {
      const cleanResult = await cleanWorkspace(sourceDir, `${description} (retry cleanup)`);
      if (!cleanResult.success) {
        console.log(chalk.yellow(`    ⚠️ Workspace cleanup failed, continuing anyway: ${cleanResult.error.message}`));
      }
    }

    // Check for uncommitted changes with retry logic
    const status = await executeGitCommandWithRetry(['git', 'status', '--porcelain'], sourceDir, 'status check');
    const hasChanges = status.stdout.trim().length > 0;

    // Stage changes with retry logic
    await executeGitCommandWithRetry(['git', 'add', '-A'], sourceDir, 'staging changes');

    // Create commit with retry logic
    await executeGitCommandWithRetry(['git', 'commit', '-m', `📍 Checkpoint: ${description} (attempt ${attempt})`, '--allow-empty'], sourceDir, 'creating commit');

    if (hasChanges) {
      console.log(chalk.blue(`    ✅ Checkpoint created with uncommitted changes staged`));
    } else {
      console.log(chalk.blue(`    ✅ Empty checkpoint created (no workspace changes)`));
    }
    return { success: true };
  } catch (error) {
    console.log(chalk.yellow(`    ⚠️ Checkpoint creation failed after retries: ${error.message}`));
    return { success: false, error };
  }
};

/**
 * [목적] 성공 결과를 커밋으로 확정.
 *
 * [호출자]
 * - runAgentPromptWithRetry() 성공 시
 *
 * [출력 대상]
 * - 커밋 생성 및 해시 반환
 *
 * [입력 파라미터]
 * - sourceDir (string)
 * - description (string)
 *
 * [반환값]
 * - Promise<object>
 */
export const commitGitSuccess = async (sourceDir, description) => {
  console.log(chalk.green(`    💾 Committing successful results for ${description}`));
  try {
    // Check what we're about to commit with retry logic
    const status = await executeGitCommandWithRetry(['git', 'status', '--porcelain'], sourceDir, 'status check for success commit');
    const changes = status.stdout.trim().split('\n').filter(line => line.length > 0);

    // Stage changes with retry logic
    await executeGitCommandWithRetry(['git', 'add', '-A'], sourceDir, 'staging changes for success commit');

    // Create success commit with retry logic
    await executeGitCommandWithRetry(['git', 'commit', '-m', `✅ ${description}: completed successfully`, '--allow-empty'], sourceDir, 'creating success commit');

    const headResult = await executeGitCommandWithRetry(['git', 'rev-parse', 'HEAD'], sourceDir, 'getting success commit hash');
    const commitHash = headResult.stdout.trim();

    if (changes.length > 0) {
      console.log(chalk.green(`    ✅ Success commit created with ${changes.length} file changes:`));
      changes.slice(0, 5).forEach(change => console.log(chalk.gray(`       ${change}`)));
      if (changes.length > 5) {
        console.log(chalk.gray(`       ... and ${changes.length - 5} more files`));
      }
    } else {
      console.log(chalk.green(`    ✅ Empty success commit created (agent made no file changes)`));
    }
    return { success: true, commitHash };
  } catch (error) {
    console.log(chalk.yellow(`    ⚠️ Success commit failed after retries: ${error.message}`));
    return { success: false, error };
  }
};

/**
 * [목적] 현재 HEAD 커밋 해시 조회.
 *
 * [호출자]
 * - 체크포인트/상태 기록 로직
 *
 * [반환값]
 * - Promise<string|null>
 */
export const getGitHeadHash = async (sourceDir) => {
  try {
    const result = await executeGitCommandWithRetry(['git', 'rev-parse', 'HEAD'], sourceDir, 'getting commit hash');
    return result.stdout.trim();
  } catch (error) {
    return null;
  }
};

/**
 * [목적] 워크스페이스 롤백 및 정리.
 *
 * [호출자]
 * - 재시도 준비 단계
 *
 * [입력 파라미터]
 * - sourceDir (string)
 * - reason (string)
 *
 * [반환값]
 * - Promise<object>
 */
export const rollbackGitWorkspace = async (sourceDir, reason = 'retry preparation') => {
  console.log(chalk.yellow(`    🔄 Rolling back workspace for ${reason}`));
  try {
    // Show what we're about to remove with retry logic
    const status = await executeGitCommandWithRetry(['git', 'status', '--porcelain'], sourceDir, 'status check for rollback');
    const changes = status.stdout.trim().split('\n').filter(line => line.length > 0);

    // Reset and clean with preservation logic to avoid losing valuable deliverables
    await preserveDeliverables(sourceDir, async () => {
      // Reset to HEAD with retry logic
      await executeGitCommandWithRetry(['git', 'reset', '--hard', 'HEAD'], sourceDir, 'hard reset for rollback');

      // Clean untracked files with retry logic
      await executeGitCommandWithRetry(['git', 'clean', '-fd', '-e', 'deliverables/', '-e', 'outputs/'], sourceDir, 'cleaning untracked files for rollback');
    });

    if (changes.length > 0) {
      console.log(chalk.yellow(`    ✅ Rollback completed - removed ${changes.length} contaminated changes:`));
      changes.slice(0, 3).forEach(change => console.log(chalk.gray(`       ${change}`)));
      if (changes.length > 3) {
        console.log(chalk.gray(`       ... and ${changes.length - 3} more files`));
      }
    } else {
      console.log(chalk.yellow(`    ✅ Rollback completed - no changes to remove`));
    }
    return { success: true };
  } catch (error) {
    console.log(chalk.red(`    ❌ Rollback failed after retries: ${error.message}`));
    return { success: false, error };
  }
};

// ─────────────────────────────────────────────
// 병렬 phase 지원: 에이전트별 deliverable 정리 & phase 단위 커밋
// ─────────────────────────────────────────────

/**
 * [목적] 에이전트의 최종 산출물만 삭제하고 롱텀 메모리(findings)는 보존.
 *
 * 병렬 phase에서 에이전트 재실행(--rerun) 시 git rollback 대신 사용.
 * - 최종 산출물 (A): *_queue.json, *_evidence.json, *_deliverable.md 등 → 삭제
 * - 롱텀 메모리 (B): deliverables/findings/<agent>/ (todo.txt, finding_*.md) → 보존
 *
 * [호출자]
 * - checkpoint-manager.js::rerunAgent() (병렬 에이전트 재실행 시)
 *
 * @param {string} sourceDir - 대상 프로젝트 디렉토리 (repos/juice-shop 등)
 * @param {string} agentName - 에이전트 이름 (e.g., 'sqli-vuln', 'sqli-exploit')
 * @returns {Promise<{success: boolean, deletedFiles: string[]}>}
 */
export const cleanAgentDeliverables = async (sourceDir, agentName) => {
  const deliverablesDir = path.join(sourceDir, 'deliverables');
  const deletedFiles = [];

  try {
    if (!await fs.pathExists(deliverablesDir)) {
      return { success: true, deletedFiles };
    }

    // 에이전트 이름에서 취약점 타입 추출
    // 'sqli-vuln' → 'sqli', 'sqli-exploit' → 'sqli', 'auth-vuln' → 'auth'
    const vulnType = agentName.replace(/-vuln$/, '').replace(/-exploit$/, '');
    const isExploit = agentName.endsWith('-exploit');

    // 최종 산출물 파일 패턴 (A) - 삭제 대상
    const patterns = isExploit
      ? [
          `${vulnType}_exploitation_evidence.json`,
          `${vulnType}_exploitation_evidence.md`,
        ]
      : [
          `${vulnType}_exploitation_queue.json`,
          `${vulnType}_vuln_deliverable.md`,
          `${vulnType}_vulnerability_report.md`,
        ];

    for (const pattern of patterns) {
      const filePath = path.join(deliverablesDir, pattern);
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
        deletedFiles.push(pattern);
      }
    }

    if (deletedFiles.length > 0) {
      console.log(chalk.yellow(`    🧹 Cleaned ${deletedFiles.length} deliverable(s) for ${agentName}:`));
      deletedFiles.forEach(f => console.log(chalk.gray(`       - ${f}`)));
    } else {
      console.log(chalk.gray(`    ℹ️  No deliverables to clean for ${agentName}`));
    }

    // 롱텀 메모리(findings)는 명시적으로 보존
    const findingsDir = path.join(deliverablesDir, 'findings');
    const missionName = vulnType;
    const missionDir = isExploit
      ? path.join(findingsDir, `${missionName}-exploit`)
      : path.join(findingsDir, missionName);

    if (await fs.pathExists(missionDir)) {
      console.log(chalk.blue(`    💾 Preserved long-term memory: findings/${isExploit ? missionName + '-exploit' : missionName}/`));
    }

    return { success: true, deletedFiles };
  } catch (error) {
    console.log(chalk.yellow(`    ⚠️ Deliverable cleanup failed for ${agentName}: ${error.message}`));
    return { success: false, deletedFiles, error };
  }
};

/**
 * [목적] 병렬 phase 완료 후 전체 산출물을 한 번에 커밋.
 *
 * 병렬 에이전트 실행 중에는 git 커밋을 하지 않고,
 * phase 완료 후 이 함수로 한 번에 커밋합니다.
 *
 * [호출자]
 * - checkpoint-manager.js::runPhase() (병렬 phase 완료 후)
 *
 * @param {string} sourceDir - 대상 프로젝트 디렉토리
 * @param {string} phaseName - phase 이름 (e.g., 'vulnerability-analysis')
 * @returns {Promise<{success: boolean, commitHash?: string}>}
 */
export const commitPhaseResults = async (sourceDir, phaseName) => {
  console.log(chalk.green(`    💾 Creating phase-level commit for '${phaseName}'`));
  try {
    const status = await executeGitCommandWithRetry(
      ['git', 'status', '--porcelain'], sourceDir, 'status check for phase commit'
    );
    const changes = status.stdout.trim().split('\n').filter(line => line.length > 0);

    await executeGitCommandWithRetry(
      ['git', 'add', '-A'], sourceDir, 'staging phase results'
    );

    await executeGitCommandWithRetry(
      ['git', 'commit', '-m', `📦 Phase commit: ${phaseName} completed`, '--allow-empty'],
      sourceDir, 'creating phase commit'
    );

    const headResult = await executeGitCommandWithRetry(
      ['git', 'rev-parse', 'HEAD'], sourceDir, 'getting phase commit hash'
    );
    const commitHash = headResult.stdout.trim();

    if (changes.length > 0) {
      console.log(chalk.green(`    ✅ Phase commit created with ${changes.length} file changes`));
    } else {
      console.log(chalk.green(`    ✅ Empty phase commit created (no file changes)`));
    }

    return { success: true, commitHash };
  } catch (error) {
    console.log(chalk.yellow(`    ⚠️ Phase commit failed: ${error.message}`));
    return { success: false, error };
  }
};
