/**
 * DokodemoDoor Helper MCP Server
 *
 * In-process MCP server providing core tools for penetration testing agents.
 *
 * Tools include:
 * - save_deliverable: Guarded result storage
 * - list_files: High-performance directory listing
 * - read_file: Smart file reading with path recovery
 * - search_file: Optimized content search (grep/rg)
 * - write_file: Safe file writing
 * - generate_totp: Multi-factor auth generation
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { saveDeliverableTool } from './tools/save-deliverable.js';
import { generateTotpTool } from './tools/generate-totp.js';
import { listFilesTool } from './tools/list-files.js';
import { readFileTool } from './tools/read-file.js';
import { searchFilesTool } from './tools/search-tools.js';
import { writeFileTool } from './tools/write-file.js';
import { taskAgentTool } from './tools/task-agent.js';

/**
 * [목적] DokodemoDoor helper MCP 서버 생성 및 타겟 디렉터리 설정.
 *
 * [호출자]
 * - agent-executor (로컬 MCP 도구 등록)
 *
 * [출력 대상]
 * - MCP 서버 인스턴스 반환
 *
 * [입력 파라미터]
 * - targetDir (string)
 *
 * [반환값]
 * - object
 */
export function createDokodemoDoorHelperServer(targetDir) {
  // Store target directory for tool access
  global.__DOKODEMODOOR_TARGET_DIR = targetDir;

  return createSdkMcpServer({
    name: 'dokodemodoor-helper',
    version: '1.2.0',
    tools: [
      saveDeliverableTool,
      generateTotpTool,
      listFilesTool,
      readFileTool,
      searchFilesTool,
      writeFileTool,
      taskAgentTool
    ],
  });
}

// Export tools for direct usage if needed
export {
  saveDeliverableTool,
  generateTotpTool,
  listFilesTool,
  readFileTool,
  searchFilesTool,
  writeFileTool,
  taskAgentTool
};

// Export types for external use
export * from './types/index.js';
