import chalk from 'chalk';
import {
  deleteSession, deleteAllSessions,
  validateAgent, validatePhase, reconcileSession,
  findSessionByIdOrSelection
} from '../session-manager.js';
import {
  runPhase, runAll, rollbackTo, rerunAgent, displayStatus, listAgents
} from '../checkpoint-manager.js';
import { logError, PentestError } from '../error-handling.js';
import { promptConfirmation } from './prompts.js';

// Developer command handlers
/**
 * [목적] 개발자용 CLI 명령 처리(실행/상태/롤백 등).
 *
 * [호출자]
 * - dokodemodoor.mjs CLI 파싱 후
 *
 * [출력 대상]
 * - 각 명령에 맞는 실행 함수 호출 및 콘솔 출력
 *
 * [입력 파라미터]
 * - command (string)
 * - args (array)
 * - runAgentPromptWithRetry (function)
 * - loadPrompt (function)
 * - providedSessionId (string|null)
 *
 * [반환값]
 * - Promise<void>
 *
 * [부작용]
 * - 세션 선택/수정, 로그 출력
 *
 * [에러 처리]
 * - 에러 발생 시 로깅 후 re-throw (호출자가 exit 관리)
 */
export async function handleDeveloperCommand(command, args, runAgentPromptWithRetry, loadPrompt, providedSessionId = null) {
  try {
    let session;

    // Commands that don't require session selection
    if (command === '--list-agents') {
      listAgents();
      return;
    }

    if (command === '--cleanup') {
      // Handle cleanup without needing session selection first
      const sessionId = args[0] || providedSessionId;

      if (sessionId) {
        // Cleanup specific session by ID
        const deletedSession = await deleteSession(sessionId);
        console.log(chalk.green(`✅ Deleted session ${sessionId} (${new URL(deletedSession.webUrl).hostname})`));
      } else {
        // Cleanup all sessions - require confirmation
        const confirmed = await promptConfirmation(chalk.yellow('⚠️  This will delete all pentest sessions. Are you sure? (y/N):'));
        if (confirmed) {
          const deleted = await deleteAllSessions();
          if (deleted) {
            console.log(chalk.green('✅ All sessions deleted'));
          } else {
            console.log(chalk.yellow('⚠️  No sessions found to delete'));
          }
        } else {
          console.log(chalk.gray('Cleanup cancelled'));
        }
      }
      return;
    }

    // Early validation for commands with agent names (before session selection)

    if (command === '--run-phase') {
      if (!args[0]) {
        throw new PentestError(
          '--run-phase requires a phase name',
          'cli',
          false,
          { usage: './dokodemodoor.mjs --run-phase <phase-name>' }
        );
      }
      validatePhase(args[0]); // This will throw PentestError if invalid
    }

    if (command === '--rollback-to' || command === '--rerun') {
      if (!args[0]) {
        throw new PentestError(
          `${command} requires an agent name`,
          'cli',
          false,
          { usage: `./dokodemodoor.mjs ${command} <agent-name>` }
        );
      }
      validateAgent(args[0]); // This will throw PentestError if invalid
    }

    // Get session for other commands
    session = await findSessionByIdOrSelection(providedSessionId);

    // Self-healing: Reconcile session with audit logs before executing command
    // This ensures DokodemoDoor store is consistent with audit data, even after crash recovery
    try {
      const reconcileOptions = command === '--status'
        ? { includeStaleRunning: false }
        : undefined;
      const reconcileReport = await reconcileSession(session.id, reconcileOptions);

      if (reconcileReport.promotions.length > 0) {
        console.log(chalk.blue(`🔄 Reconciled: Added ${reconcileReport.promotions.length} completed agents from audit logs`));
      }
      if (reconcileReport.demotions.length > 0) {
        console.log(chalk.yellow(`🔄 Reconciled: Removed ${reconcileReport.demotions.length} rolled-back agents`));
      }
      if (reconcileReport.failures.length > 0) {
        console.log(chalk.yellow(`🔄 Reconciled: Marked ${reconcileReport.failures.length} failed agents`));
      }

      // Reload session after reconciliation to get fresh state
      const { getSession } = await import('../session-manager.js');
      session = await getSession(session.id);
    } catch (error) {
      // Reconciliation failure is non-critical, but log warning
      console.log(chalk.yellow(`⚠️  Failed to reconcile session with audit logs: ${error.message}`));
    }

    switch (command) {

      case '--run-phase':
        await runPhase(args[0], session, runAgentPromptWithRetry, loadPrompt);
        break;

      case '--run-all':
        await runAll(session, runAgentPromptWithRetry, loadPrompt);
        break;

      case '--rollback-to':
        await rollbackTo(args[0], session);
        break;

      case '--rerun':
        await rerunAgent(args[0], session, runAgentPromptWithRetry, loadPrompt);
        break;

      case '--status':
        await displayStatus(session);
        break;

      default:
        throw new PentestError(
          `Unknown developer command: ${command}`,
          'cli',
          false,
          { hint: 'Use --help to see available commands' }
        );
    }
  } catch (error) {
    if (error instanceof PentestError) {
      await logError(error, `Developer command ${command}`);
      console.log(chalk.red.bold(`\n🚨 Command failed: ${error.message}`));
    } else {
      console.log(chalk.red.bold(`\n🚨 Unexpected error: ${error.message}`));
      if (process.env.DEBUG) {
        console.log(chalk.gray(error.stack));
      }
    }
    throw error; // Re-throw to let caller handle exit
  }
}
