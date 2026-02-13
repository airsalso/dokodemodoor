#!/usr/bin/env node
/**
 * RE Ghidra MCP Server
 *
 * Ghidra headless analyzer를 활용한 정적 분석 MCP 도구 서버.
 * analyzeHeadless + GhidraScript 브릿지를 통해 디컴파일, 함수 목록,
 * Import/Export, 문자열, 교차참조 등의 분석을 제공합니다.
 */
import { McpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

const GHIDRA_HOME = process.env.GHIDRA_HOME || '/opt/ghidra';
const GHIDRA_PROJECT_DIR = process.env.GHIDRA_PROJECT_DIR || join(tmpdir(), 'ghidra-projects');
const SCRIPTS_DIR = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), 'scripts');

// Ensure project directory exists
if (!existsSync(GHIDRA_PROJECT_DIR)) {
  mkdirSync(GHIDRA_PROJECT_DIR, { recursive: true });
}

/**
 * [목적] Ghidra analyzeHeadless 실행 래퍼.
 *
 * @param {string[]} args - analyzeHeadless 추가 인자
 * @param {object} options - timeout 등 옵션
 */
async function runGhidraHeadless(args, options = {}) {
  const analyzeHeadless = join(GHIDRA_HOME, 'support', 'analyzeHeadless');
  // Windows에서는 .bat 확장자 필요
  const cmd = process.platform === 'win32' ? `${analyzeHeadless}.bat` : analyzeHeadless;

  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: options.timeout || 300000, // 5분 기본
      maxBuffer: 50 * 1024 * 1024, // 50MB
      windowsHide: true,
      ...options
    });
    return { success: true, stdout, stderr };
  } catch (error) {
    return {
      success: false,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      error: error.message
    };
  }
}

/**
 * [목적] GhidraScript를 실행하고 JSON 결과를 읽어 반환.
 *
 * @param {string} projectName - Ghidra 프로젝트 이름
 * @param {string} binaryName - 프로그램 이름
 * @param {string} scriptName - 실행할 GhidraScript 이름
 * @param {string[]} scriptArgs - 스크립트에 전달할 인자
 */
async function runGhidraScript(projectName, binaryName, scriptName, scriptArgs = []) {
  const outputFile = join(tmpdir(), `ghidra-output-${randomUUID()}.json`);

  const args = [
    GHIDRA_PROJECT_DIR, projectName,
    '-process', binaryName,
    '-noanalysis', // 이미 분석된 프로젝트 사용
    '-scriptPath', SCRIPTS_DIR,
    '-postScript', scriptName, outputFile, ...scriptArgs
  ];

  const result = await runGhidraHeadless(args, { timeout: 180000 });

  if (existsSync(outputFile)) {
    try {
      const content = readFileSync(outputFile, 'utf8');
      return { success: true, data: JSON.parse(content) };
    } catch (e) {
      return { success: false, error: `Failed to parse script output: ${e.message}` };
    }
  }

  return {
    success: false,
    error: result.error || 'Script produced no output',
    stderr: result.stderr
  };
}

// 현재 로드된 프로젝트 추적
let currentProject = null;
let currentBinary = null;

const server = new McpServer({
  name: 're-ghidra',
  version: '1.0.0',
  description: 'Ghidra-based static analysis: decompile, functions, imports, strings, xrefs, search'
});

/**
 * ghidra_analyze — 바이너리를 Ghidra 프로젝트로 import하고 자동 분석 실행
 */
server.tool(
  'ghidra_analyze',
  {
    binary_path: z.string().describe('분석할 바이너리 파일 경로'),
    project_name: z.string().optional().describe('Ghidra 프로젝트 이름 (기본: 바이너리 이름)')
  },
  async ({ binary_path, project_name }) => {
    if (!existsSync(binary_path)) {
      return { content: [{ type: 'text', text: `Error: File not found: ${binary_path}` }] };
    }

    const binaryName = basename(binary_path);
    const projName = project_name || binaryName.replace(/\.[^.]+$/, '');

    const args = [
      GHIDRA_PROJECT_DIR, projName,
      '-import', binary_path,
      '-overwrite'  // 기존 프로젝트 덮어쓰기
    ];

    const result = await runGhidraHeadless(args, { timeout: 600000 }); // 10분

    if (result.success || result.stdout.includes('Import succeeded')) {
      currentProject = projName;
      currentBinary = binaryName;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            project: projName,
            binary: binaryName,
            project_dir: GHIDRA_PROJECT_DIR,
            message: 'Binary imported and analyzed successfully'
          }, null, 2)
        }]
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: result.error,
          stderr: result.stderr?.substring(0, 2000)
        }, null, 2)
      }]
    };
  }
);

/**
 * ghidra_list_functions — 함수 목록 (주소, 크기, 이름)
 */
server.tool(
  'ghidra_list_functions',
  {
    filter: z.string().optional().describe('함수 이름 필터 (정규식 패턴)'),
    limit: z.number().optional().describe('최대 결과 수 (기본: 200)')
  },
  async ({ filter, limit }) => {
    if (!currentProject || !currentBinary) {
      return { content: [{ type: 'text', text: 'Error: No project loaded. Run ghidra_analyze first.' }] };
    }

    const scriptArgs = [filter || '', String(limit || 200)];
    const result = await runGhidraScript(currentProject, currentBinary, 'ListFunctions.java', scriptArgs);

    return {
      content: [{
        type: 'text',
        text: result.success
          ? JSON.stringify(result.data, null, 2)
          : `Error: ${result.error}`
      }]
    };
  }
);

/**
 * ghidra_decompile — 특정 함수 디컴파일 (C 의사코드 반환)
 */
server.tool(
  'ghidra_decompile',
  {
    function_name: z.string().optional().describe('함수 이름'),
    address: z.string().optional().describe('함수 주소 (0x 형식)')
  },
  async ({ function_name, address }) => {
    if (!currentProject || !currentBinary) {
      return { content: [{ type: 'text', text: 'Error: No project loaded. Run ghidra_analyze first.' }] };
    }
    if (!function_name && !address) {
      return { content: [{ type: 'text', text: 'Error: Provide function_name or address.' }] };
    }

    const target = function_name || address;
    const result = await runGhidraScript(currentProject, currentBinary, 'Decompile.java', [target]);

    return {
      content: [{
        type: 'text',
        text: result.success
          ? JSON.stringify(result.data, null, 2)
          : `Error: ${result.error}`
      }]
    };
  }
);

/**
 * ghidra_list_imports — Import DLL/함수 목록
 */
server.tool(
  'ghidra_list_imports',
  {},
  async () => {
    if (!currentProject || !currentBinary) {
      return { content: [{ type: 'text', text: 'Error: No project loaded. Run ghidra_analyze first.' }] };
    }

    const result = await runGhidraScript(currentProject, currentBinary, 'ListImports.java');

    return {
      content: [{
        type: 'text',
        text: result.success
          ? JSON.stringify(result.data, null, 2)
          : `Error: ${result.error}`
      }]
    };
  }
);

/**
 * ghidra_list_strings — 관심 문자열 목록 (URL, 레지스트리키, 암호화 상수 등)
 */
server.tool(
  'ghidra_list_strings',
  {
    min_length: z.number().optional().describe('최소 문자열 길이 (기본: 6)'),
    filter: z.string().optional().describe('문자열 필터 패턴 (정규식)')
  },
  async ({ min_length, filter }) => {
    if (!currentProject || !currentBinary) {
      return { content: [{ type: 'text', text: 'Error: No project loaded. Run ghidra_analyze first.' }] };
    }

    const scriptArgs = [String(min_length || 6), filter || ''];
    const result = await runGhidraScript(currentProject, currentBinary, 'ListStrings.java', scriptArgs);

    return {
      content: [{
        type: 'text',
        text: result.success
          ? JSON.stringify(result.data, null, 2)
          : `Error: ${result.error}`
      }]
    };
  }
);

/**
 * ghidra_xrefs — 특정 함수/주소의 교차참조
 */
server.tool(
  'ghidra_xrefs',
  {
    target: z.string().describe('함수 이름 또는 주소 (0x 형식)'),
    direction: z.enum(['to', 'from', 'both']).optional().describe('참조 방향 (기본: both)')
  },
  async ({ target, direction }) => {
    if (!currentProject || !currentBinary) {
      return { content: [{ type: 'text', text: 'Error: No project loaded. Run ghidra_analyze first.' }] };
    }

    const scriptArgs = [target, direction || 'both'];
    const result = await runGhidraScript(currentProject, currentBinary, 'GetXrefs.java', scriptArgs);

    return {
      content: [{
        type: 'text',
        text: result.success
          ? JSON.stringify(result.data, null, 2)
          : `Error: ${result.error}`
      }]
    };
  }
);

/**
 * ghidra_search — 키워드 패턴으로 함수 검색 (network/auth/crypto 등)
 */
server.tool(
  'ghidra_search',
  {
    category: z.enum(['network', 'authentication', 'cryptography', 'license', 'update', 'anti-tamper', 'file-io', 'registry', 'sysconfig', 'custom']).describe('검색 카테고리'),
    custom_pattern: z.string().optional().describe('custom 카테고리일 때 사용할 정규식 패턴')
  },
  async ({ category, custom_pattern }) => {
    if (!currentProject || !currentBinary) {
      return { content: [{ type: 'text', text: 'Error: No project loaded. Run ghidra_analyze first.' }] };
    }

    // 카테고리별 기본 검색 패턴
    const patterns = {
      network: 'WinHttp|WinInet|WSA|socket|connect|send|recv|curl|http|https|url|InternetOpen|HttpSend|getaddrinfo|gethostbyname|inet_',
      authentication: 'Login|Auth|Password|Credential|Token|Session|OAuth|JWT|CredRead|LogonUser|PAM|pam_|crypt_r|getpwnam',
      cryptography: 'Crypt|BCrypt|NCrypt|AES|RSA|SHA|MD5|HMAC|Encrypt|Decrypt|Hash|CipherKey|EVP_|SSL_|TLS_|OPENSSL',
      license: 'License|Serial|Activate|Register|Trial|Expire|Validate|Product.?Key',
      update: 'Update|Download|Version|Patch|AutoUpdate|CheckForUpdate',
      'anti-tamper': 'IsDebugger|CheckRemote|NtQueryInformation|Integrity|Tamper|CRC|Checksum|ptrace|PTRACE',
      'file-io': 'CreateFile|ReadFile|WriteFile|DeleteFile|MoveFile|CopyFile|FindFirst|open|read|write|fopen|fclose|stat|access|unlink',
      registry: 'RegOpen|RegCreate|RegSet|RegQuery|RegDelete|Registry',
      sysconfig: 'getenv|setenv|sysconf|pathconf|dlopen|dlsym|ioctl|mmap|mprotect'
    };

    const pattern = category === 'custom' ? (custom_pattern || '') : patterns[category];
    const scriptArgs = [pattern, category];
    const result = await runGhidraScript(currentProject, currentBinary, 'SearchFunctions.java', scriptArgs);

    return {
      content: [{
        type: 'text',
        text: result.success
          ? JSON.stringify(result.data, null, 2)
          : `Error: ${result.error}`
      }]
    };
  }
);

// Start server
server.run({ transport: 'stdio' }).catch(console.error);
