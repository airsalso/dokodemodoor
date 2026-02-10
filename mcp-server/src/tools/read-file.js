/**
 * read_file MCP Tool (Parity-Optimized)
 */

import { z } from 'zod';
import { createToolResult } from '../types/tool-responses.js';
import { getTargetDir } from '../../../src/utils/context.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { shQuote, recoverPath, ensureInSandbox } from '../utils/shell-utils.js';

const execAsync = promisify(exec);

export const ReadFileInputSchema = z.object({
  path: z.string().describe('Path to the file to read'),
  line_start: z.coerce.number().int().optional().describe('Starting line number (1-indexed)'),
  line_end: z.coerce.number().int().optional().describe('Ending line number'),
  cwd: z.string().optional().describe('Optional working directory')
});

export async function readFile(args) {
  try {
    const targetDir = getTargetDir();
    let filePath = args.path;
    const workDir = args.cwd ? path.resolve(targetDir, args.cwd) : targetDir;

    // 1. Recover Path (Now includes README logic in shell-utils)
    filePath = await recoverPath(filePath, targetDir);

    // 2. Sandbox Gate
    filePath = ensureInSandbox(filePath, targetDir);

    if (!existsSync(filePath)) {
      return createToolResult({ status: 'error', message: `File not found: ${args.path}` });
    }

    // Parity: If it's a directory, return a listing instead of erroring with cat
    if (statSync(filePath).isDirectory()) {
       const { stdout } = await execAsync(`ls -la ${shQuote(filePath)}`, { cwd: workDir });
       return createToolResult({
         status: 'success',
         message: 'Target is a directory. Showing list instead.',
         content: stdout,
         path: path.relative(targetDir, filePath)
       });
    }

    // 3. Content Extraction
    let cmd = '';
    const start = args.line_start || 1;
    const end = args.line_end || '$';

    if (args.line_start !== undefined || args.line_end !== undefined) {
      cmd = `sed -n '${start},${end}p' ${shQuote(filePath)}`;
    } else {
      cmd = `cat ${shQuote(filePath)}`;
    }

    const { stdout } = await execAsync(cmd, { cwd: workDir });

    return createToolResult({
      status: 'success',
      content: stdout,
      path: path.relative(targetDir, filePath)
    });

  } catch (error) {
    return createToolResult({
      status: 'error',
      message: `Failed to read file: ${error.message}`
    });
  }
}

export const readFileTool = {
  name: 'read_file',
  description: 'Reads file content. If path is a directory, shows directory listing. Supports line ranges.',
  inputSchema: ReadFileInputSchema,
  handler: readFile
};
