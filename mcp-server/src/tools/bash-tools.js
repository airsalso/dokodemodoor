/**
 * bash_executor MCP Tool (Hardened & Parity-Fixed)
 */

import { z } from 'zod';
import { createToolResult } from '../types/tool-responses.js';
import { getTargetDir, getAgentName, getWebUrl } from '../../../src/utils/context.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import { scrubCommand, isHeavyRootCommand, autoFixCommand, shQuote, recoverPath, ensureInSandbox } from '../utils/shell-utils.js';

const execAsync = promisify(exec);

export const BashInputSchema = z.object({
  command: z.string().optional().describe('The bash command to execute'),
  path: z.string().optional().describe('Target path for operations'),
  query: z.string().optional().describe('Search query for grep/rg'),
  cwd: z.string().optional().describe('Working directory relative to repo root')
});

export async function executeBash(args) {
  try {
    const targetDir = getTargetDir();
    const agentName = (getAgentName() || '').toLowerCase();
    const webUrl = getWebUrl();

    let command = scrubCommand(args.command);
    let filePath = args.path;
    const workDir = args.cwd ? path.resolve(targetDir, args.cwd) : targetDir;

    // 1. Recover and Sandbox Path
    if (filePath) {
      filePath = await recoverPath(filePath, targetDir);
      filePath = ensureInSandbox(filePath, targetDir);
    }

    // 2. Parity Fix: Directory Detection for path arguments
    // Original Know-how: If path is a directory and no command exists, use ls -la.
    if (!command && filePath) {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        command = `ls -la ${shQuote(filePath)}`;
      } else {
        command = `cat ${shQuote(filePath)}`;
      }
    } else if (command && filePath) {
      command = autoFixCommand(command, filePath);
    }

    if (!command && args.query) {
      command = `grep -rn ${shQuote(args.query)} ${shQuote(filePath || '.')} | head -n 100`;
    }

    // 3. Command Validation & Safety
    if (!command || /^\s*(cat|grep|sed|awk|head|tail|ls)\s*$/.test(command)) {
      return createToolResult({
        status: 'error',
        message: 'Invalid or missing command arguments.',
        errorType: 'ValidationError'
      });
    }

    const resolvedWorkDir = ensureInSandbox(workDir, targetDir);
    if (isHeavyRootCommand(command, resolvedWorkDir)) {
      return createToolResult({
        status: 'error',
        message: 'Blocked heavy filesystem scan at root.',
        errorType: 'SecurityError'
      });
    }

    // api-fuzzer drift prevention
    if (agentName.includes('api-fuzzer') && webUrl) {
      const host = (() => { try { return new URL(webUrl).hostname; } catch { return null; } })();
      const usesLocalhost = /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(command);
      const isTargetLocal = host === 'localhost' || host === '127.0.0.1';
      if (usesLocalhost && !isTargetLocal) {
        return createToolResult({ status: 'error', message: `Blocked: Use target webUrl (${webUrl}).`, errorType: 'SecurityError' });
      }
    }

    console.log(chalk.gray(`      🐚 Executing: ${command}`));

    const { stdout, stderr } = await execAsync(command, {
      cwd: resolvedWorkDir,
      timeout: 60000
    });

    return createToolResult({
      status: 'success',
      output: stdout,
      stderr: stderr,
      exitCode: 0
    });

  } catch (error) {
    return createToolResult({
      status: 'error',
      message: `Command failed: ${error.message}`,
      output: error.stdout,
      stderr: error.stderr,
      exitCode: error.code || 1
    });
  }
}

export const bashTool = {
  name: 'bash',
  description: 'Execute bash commands with smart directory detection and safety guards.',
  inputSchema: BashInputSchema,
  handler: executeBash
};
