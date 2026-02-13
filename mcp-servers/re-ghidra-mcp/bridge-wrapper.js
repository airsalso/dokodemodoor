#!/usr/bin/env node
/**
 * RE Ghidra MCP Bridge Wrapper
 *
 * [목적] bethington/ghidra-mcp의 bridge_mcp_ghidra.py를 stdio MCP로 래핑.
 *
 * DokodemoDoor의 MCP 프록시는 stdio 기반이므로, 이 래퍼가
 * bridge_mcp_ghidra.py를 stdio 모드로 실행하여 연결한다.
 *
 * [호출자]
 * - re-tools.json의 re-ghidra 서버 설정
 *
 * [동작 방식]
 * 1. bridge_mcp_ghidra.py를 stdio 전송 모드로 spawn
 * 2. stdin/stdout을 직접 파이프하여 MCP 프로토콜 전달
 * 3. Ghidra GUI + Plugin의 HTTP 서버(:8080)와 통신
 */
import { spawn } from 'child_process';
import { join } from 'path';

const GHIDRA_MCP_DIR = process.env.GHIDRA_MCP_DIR || '/opt/ghidra-mcp';
const GHIDRA_HTTP_PORT = process.env.GHIDRA_MCP_HTTP_PORT || '8080';
const BRIDGE_SCRIPT = join(GHIDRA_MCP_DIR, 'bridge_mcp_ghidra.py');

// bridge_mcp_ghidra.py를 stdio 전송 모드로 실행
const bridge = spawn('python3', [
  BRIDGE_SCRIPT,
  '--transport', 'stdio',
  '--ghidra-server', `http://127.0.0.1:${GHIDRA_HTTP_PORT}/`
], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PYTHONUNBUFFERED: '1'
  }
});

// stdin → bridge stdin (MCP 요청 전달)
process.stdin.pipe(bridge.stdin);

// bridge stdout → stdout (MCP 응답 전달)
bridge.stdout.pipe(process.stdout);

// bridge stderr → stderr (에러/디버그 로그)
bridge.stderr.on('data', (data) => {
  process.stderr.write(data);
});

// 프로세스 종료 처리
bridge.on('exit', (code) => {
  process.exit(code || 0);
});

bridge.on('error', (err) => {
  process.stderr.write(`Bridge error: ${err.message}\n`);
  process.exit(1);
});

// 부모 프로세스 종료 시 bridge도 종료
process.on('SIGINT', () => { bridge.kill('SIGINT'); });
process.on('SIGTERM', () => { bridge.kill('SIGTERM'); });

// stdin 닫힘 시 bridge stdin도 닫기
process.stdin.on('end', () => {
  bridge.stdin.end();
});
