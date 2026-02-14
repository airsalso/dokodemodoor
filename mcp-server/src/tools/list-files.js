/**
 * list_files MCP Tool (Hardened)
 */

import { z } from 'zod';
import { createToolResult } from '../types/tool-responses.js';
import { getTargetDir } from '../../../src/utils/context.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import path from 'path';
import { shQuote, isRgAvailable, recoverPath, ensureInSandbox } from '../utils/shell-utils.js';

const execAsync = promisify(exec);
const DEFAULT_MAX_RESULTS = 400;

const EXCLUDED_DIRS = [
  'node_modules', 'vendor', '.git', '.idea', '.vscode',
  'audit-logs', 'reports',
  'sessions', 'repos', 'osv-logs',
  'dist', 'build', 'target', 'bin', 'obj', 'out',
  '__pycache__', 'venv', '.venv'
];

export const ListFilesInputSchema = z.object({
  path: z.string().optional().describe('Root path to search (default: ".")'),
  query: z.string().optional().describe('Substring to match in file path or name'),
  max_results: z.coerce.number().int().min(1).max(1000).optional().describe('Maximum number of files to return'),
  command: z.string().optional().describe('Legacy backward compatibility for raw flags'),
  cwd: z.string().optional().describe('Working directory')
});

export async function listFiles(args = {}) {
  try {
    const targetDir = getTargetDir();
    let inputPath = args.path || '.';
    const query = args.query || '';
    const maxResults = args.max_results ?? DEFAULT_MAX_RESULTS;
    const workDir = args.cwd ? path.resolve(targetDir, args.cwd) : targetDir;

    // 1. Recover path (LLM 오타/환각 보정) + Sandbox Check
    let basePath = path.isAbsolute(inputPath) ? inputPath : path.resolve(workDir, inputPath);
    basePath = await recoverPath(basePath, targetDir);
    basePath = ensureInSandbox(basePath, targetDir);

    if (!existsSync(basePath)) {
      return createToolResult({
        status: 'error',
        message: `Path does not exist: ${inputPath}`,
        errorType: 'FileSystemError'
      });
    }

    // 2. Performance-based Execution
    let cmd = '';
    const rgExcludes = EXCLUDED_DIRS.map(e => `-g '!${e}'`).join(' ');
    const findExcludes = EXCLUDED_DIRS.map(e => `-path '*/${e}*' -prune -o`).join(' ');

    if (isRgAvailable()) {
      const globFilter = query ? `-g ${shQuote(`*${query}*`)}` : '';
      const flags = (args.command && args.command.startsWith('-')) ? args.command : '';
      cmd = `rg ${flags} --files ${rgExcludes} ${globFilter} ${shQuote(basePath)} | head -n ${maxResults}`;
    } else {
      const nameFilter = query ? `-name ${shQuote(`*${query}*`)}` : '';
      cmd = `find ${shQuote(basePath)} ${findExcludes} -type f ${nameFilter} -print | head -n ${maxResults}`;
    }

    const { stdout } = await execAsync(cmd, { cwd: workDir });

    const rawFiles = stdout.trim().split('\n').filter(Boolean);
    const files = rawFiles.map(f => path.relative(targetDir, f));

    const header = `FOUND_FILES: ${files.length}`;
    return {
      content: [{ type: 'text', text: `${header}\n\n${files.join('\n')}` }],
      isError: false
    };

  } catch (error) {
    return createToolResult({
      status: 'error',
      message: `Failed to list files: ${error.message}`,
      errorType: error.message.includes('Permission Denied') ? 'SecurityError' : 'FileSystemError'
    });
  }
}

export const listFilesTool = {
  name: 'list_files',
  description: 'Lists files recursively under a path with smart exclusions and substring filtering. Optimized for large repos.',
  inputSchema: ListFilesInputSchema,
  handler: listFiles
};
