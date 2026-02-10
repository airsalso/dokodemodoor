/**
 * search_file MCP Tool (Hardened)
 */

import { z } from 'zod';
import { createToolResult } from '../types/tool-responses.js';
import { getTargetDir } from '../../../src/utils/context.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { shQuote, isRgAvailable, ensureInSandbox } from '../utils/shell-utils.js';

const execAsync = promisify(exec);

const EXCLUDED_DIRS = [
  'node_modules', 'vendor', '.git', '.idea', '.vscode',
  'audit-logs', 'reports', 'deliverables',
  'dist', 'build', 'target', 'bin', 'obj', 'out',
  '__pycache__', 'venv', '.venv'
];

export const SearchFileInputSchema = z.object({
  query: z.string().describe('Search term or regex pattern'),
  path: z.string().optional().describe('Root path to search (default: ".")'),
  max_results: z.coerce.number().int().optional().describe('Maximum matches to return'),
  cwd: z.string().optional().describe('Optional working directory')
});

export async function searchFiles(args) {
  try {
    const targetDir = getTargetDir();
    const query = args.query;
    let inputPath = args.path || '.';
    const maxResults = args.max_results || 100;
    const workDir = args.cwd ? path.resolve(targetDir, args.cwd) : targetDir;

    // 1. Sandbox Verification
    let searchPath = path.isAbsolute(inputPath) ? inputPath : path.resolve(workDir, inputPath);
    searchPath = ensureInSandbox(searchPath, targetDir);

    // 2. Optimized Query Logic
    let searchableQuery = query;
    const words = query.trim().split(/\s+/).filter(w => w.length > 0);
    if (words.length > 1) {
      searchableQuery = words.map(w => `(?=.*${w})`).join('') + '.*';
    }

    const rgExcludes = EXCLUDED_DIRS.map(e => `-g '!${e}'`).join(' ');
    const grepExcludes = EXCLUDED_DIRS.map(e => `--exclude-dir=${shQuote(e)}`).join(' ');

    const regexMeta = /[()[\]{}.+*?^$|\\]/;
    const useFixed = regexMeta.test(query) && words.length === 1;

    let cmd = '';
    if (isRgAvailable()) {
      if (useFixed) {
        cmd = `rg -n --no-heading --color never ${rgExcludes} -F ${shQuote(query)} ${shQuote(searchPath)} | head -n ${maxResults}`;
      } else if (words.length > 1) {
        cmd = `rg -n --no-heading --color never ${rgExcludes} -P ${shQuote(searchableQuery)} ${shQuote(searchPath)} | head -n ${maxResults}`;
      } else {
        cmd = `rg -n --no-heading --color never ${rgExcludes} ${shQuote(query)} ${shQuote(searchPath)} | head -n ${maxResults}`;
      }
    } else {
      if (useFixed) {
        cmd = `grep -rn ${grepExcludes} -F -- ${shQuote(query)} ${shQuote(searchPath)} | head -n ${maxResults}`;
      } else if (words.length > 1) {
        let grepChain = `grep -rn ${grepExcludes} -- . ${shQuote(searchPath)}`;
        for (const word of words) {
          grepChain += ` | grep -i ${shQuote(word)}`;
        }
        cmd = `${grepChain} | head -n ${maxResults}`;
      } else {
        cmd = `grep -rn ${grepExcludes} -- ${shQuote(query)} ${shQuote(searchPath)} | head -n ${maxResults}`;
      }
    }

    const { stdout } = await execAsync(cmd, { cwd: workDir });

    return createToolResult({
      status: 'success',
      content: stdout || '(No matches found)',
      count: stdout.split('\n').filter(Boolean).length
    });

  } catch (error) {
    if (error.code === 1 && !error.stdout) {
       return createToolResult({ status: 'success', content: '(No matches found)', count: 0 });
    }
    return createToolResult({
      status: 'error',
      message: `Search failed: ${error.message}`,
      errorType: error.message.includes('Permission Denied') ? 'SecurityError' : 'FileSystemError'
    });
  }
}

export const searchFilesTool = {
  name: 'search_file',
  description: 'Searches for content within files. Optimized with ripgrep and sandbox-aware.',
  inputSchema: SearchFileInputSchema,
  handler: searchFiles
};
