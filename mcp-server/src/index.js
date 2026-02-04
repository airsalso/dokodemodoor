/**
 * DokodemoDoor Helper MCP Server
 *
 * In-process MCP server providing save_deliverable and generate_totp tools
 * for DokodemoDoor penetration testing agents.
 *
 * Replaces bash script invocations with native tool access.
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { saveDeliverableTool } from './tools/save-deliverable.js';
import { generateTotpTool } from './tools/generate-totp.js';

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
    version: '1.0.0',
    tools: [saveDeliverableTool, generateTotpTool],
  });
}

// Export tools for direct usage if needed
export { saveDeliverableTool, generateTotpTool };

// Export types for external use
export * from './types/index.js';
