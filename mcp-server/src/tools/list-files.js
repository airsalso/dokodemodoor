/**
 * list_files MCP Tool
 *
 * Lists files under a path, optionally filtered by a substring.
 */

import { z } from 'zod';
import { createToolResult } from '../types/tool-responses.js';
import { getTargetDir } from '../../../src/utils/context.js';
import { readdir } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';

const DEFAULT_MAX_RESULTS = 400;
const DEFAULT_MAX_DEPTH = 8;

const EXCLUDED_DIRS = new Set([
  'node_modules', 'vendor', '.git', '.idea', '.vscode',
  'audit-logs', 'reports',
  'sessions', 'repos', 'osv-logs',
  'dist', 'build', 'target', 'bin', 'obj', 'out',
  '__pycache__', 'venv', '.venv'
]);

export const ListFilesInputSchema = z.object({
  path: z.string().optional().describe('Root path to search (default: ".")'),
  query: z.string().optional().describe('Substring to match in file path or name'),
  max_results: z.number().int().min(1).max(1000).optional().describe('Maximum number of files to return'),
  max_depth: z.number().int().min(1).max(20).optional().describe('Maximum directory depth to traverse'),
});

export async function listFiles(args = {}) {
  try {
    const targetDir = getTargetDir();
    const inputPath = args.path || '.';
    const basePath = path.isAbsolute(inputPath)
      ? inputPath
      : path.join(targetDir, inputPath);
    const query = (args.query || '').toLowerCase();
    const maxResults = args.max_results ?? DEFAULT_MAX_RESULTS;
    const maxDepth = args.max_depth ?? DEFAULT_MAX_DEPTH;

    const targetAbs = path.resolve(targetDir);
    const baseAbsCandidate = path.resolve(basePath);
    if (!baseAbsCandidate.startsWith(targetAbs)) {
      return createToolResult({
        status: 'error',
        message: `Path must be under target repository: ${targetDir}`,
        errorType: 'FileSystemError',
        retryable: false,
      });
    }

    if (!existsSync(basePath)) {
      return createToolResult({
        status: 'error',
        message: `Path does not exist: ${basePath}`,
        errorType: 'FileSystemError',
        retryable: false,
      });
    }

    if (!statSync(basePath).isDirectory()) {
      return createToolResult({
        status: 'error',
        message: `Path is not a directory: ${basePath}`,
        errorType: 'FileSystemError',
        retryable: false,
      });
    }

    const baseAbs = baseAbsCandidate;
    const results = [];
    const stack = [{ dir: baseAbs, depth: 0 }];

    while (stack.length && results.length < maxResults) {
      const { dir, depth } = stack.pop();
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        continue;
      }

      for (const entry of entries) {
        if (results.length >= maxResults) break;
        const full = path.join(dir, entry.name);
        const rel = path.relative(baseAbs, full);

        if (entry.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry.name)) continue;
          if (depth + 1 <= maxDepth) {
            stack.push({ dir: full, depth: depth + 1 });
          }
          continue;
        }

        const candidate = rel.toLowerCase();
        if (!query || candidate.includes(query)) {
          results.push(rel);
        }
      }
    }

    return createToolResult({
      status: 'success',
      message: `Found ${results.length} files`,
      files: results,
      count: results.length,
    });
  } catch (error) {
    return createToolResult({
      status: 'error',
      message: error?.message || 'Unknown error',
      errorType: 'FileSystemError',
      retryable: true,
    });
  }
}
