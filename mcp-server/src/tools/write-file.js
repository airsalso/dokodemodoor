/**
 * write_file MCP Tool (Hardened)
 */

import { z } from 'zod';
import { createToolResult } from '../types/tool-responses.js';
import { getTargetDir } from '../../../src/utils/context.js';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { recoverPath, ensureInSandbox } from '../utils/shell-utils.js';

export const WriteFileInputSchema = z.object({
  path: z.string().describe('Target file path'),
  content: z.string().describe('Content to write'),
  cwd: z.string().optional().describe('Optional working directory')
});

export async function writeFile(args) {
  try {
    const targetDir = getTargetDir();
    let filePath = args.path;
    const workDir = args.cwd ? path.resolve(targetDir, args.cwd) : targetDir;

    // 1. Recover path (LLM 오타/환각 보정) + Mandatory Sandbox Enforcement
    let fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(workDir, filePath);
    fullPath = await recoverPath(fullPath, targetDir);
    fullPath = ensureInSandbox(fullPath, targetDir);

    // 2. Atomic Directory Preparation
    const dir = path.dirname(fullPath);
    mkdirSync(dir, { recursive: true });

    // 3. Native FS Write (Quota-safe)
    writeFileSync(fullPath, args.content, 'utf8');

    return createToolResult({
      status: 'success',
      message: `File saved successfully: ${path.relative(targetDir, fullPath)}`,
      path: path.relative(targetDir, fullPath)
    });

  } catch (error) {
    return createToolResult({
      status: 'error',
      message: `Failed to write file: ${error.message}`,
      errorType: error.message.includes('Permission Denied') ? 'SecurityError' : 'FileSystemError'
    });
  }
}

export const writeFileTool = {
  name: 'write_file',
  description: 'Safely writes content to a file within the project sandbox. Automatically creates parent directories.',
  inputSchema: WriteFileInputSchema,
  handler: writeFile
};
