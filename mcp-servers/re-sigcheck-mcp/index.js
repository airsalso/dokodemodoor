#!/usr/bin/env node
/**
 * RE Binary Inventory MCP Server
 *
 * 바이너리 사전 인벤토리를 위한 MCP 도구 서버.
 * - Windows: Sigcheck(서명 검증) + DiE(패킹/컴파일러 탐지)
 * - Linux: file + readelf + sha256sum + DiE
 * 크로스 플랫폼: PE/ELF 모두 지원.
 *
 * 표준 MCP 프로토콜 사용: @modelcontextprotocol/sdk (stdio 전송).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { basename } from 'path';

const execFileAsync = promisify(execFile);

const IS_WINDOWS = process.platform === 'win32';
const SIGCHECK_PATH = process.env.SIGCHECK_PATH || 'sigcheck64.exe';
const DIE_PATH = process.env.DIE_PATH || 'diec';

/**
 * [목적] 외부 CLI 도구 실행 래퍼.
 */
async function runTool(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: options.timeout || 60000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      ...(IS_WINDOWS ? { windowsHide: true } : {}),
      ...options
    });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      success: false,
      stdout: error.stdout?.trim() || '',
      stderr: error.stderr?.trim() || '',
      error: error.message
    };
  }
}

function textContent(text) {
  return { content: [{ type: 'text', text }] };
}

const server = new McpServer(
  { name: 're-sigcheck', version: '1.1.0' },
  { capabilities: { tools: {} } }
);

/**
 * sigcheck_analyze — 바이너리 서명 및 기본 속성 분석
 *
 * Windows: sigcheck64.exe
 * Linux: file + readelf + sha256sum 조합
 */
server.tool(
  'sigcheck_analyze',
  '바이너리 서명 및 기본 속성 분석 (Windows: Sigcheck, Linux: file+readelf+sha256)',
  z.object({ binary_path: z.string().describe('분석할 바이너리 파일 경로') }),
  async ({ binary_path }) => {
    if (!existsSync(binary_path)) {
      return textContent(`Error: File not found: ${binary_path}`);
    }

    if (IS_WINDOWS) {
      const result = await runTool(SIGCHECK_PATH, [
        '-nobanner', '-accepteula', '-a', '-h', binary_path
      ]);

      if (!result.success && !result.stdout) {
        return textContent(`Sigcheck failed: ${result.error}\n${result.stderr}`);
      }

      const parsed = parseSigcheckOutput(result.stdout || result.stderr, binary_path);
      return textContent(JSON.stringify(parsed, null, 2));
    }

    const [fileResult, readelfResult, sha256Result] = await Promise.all([
      runTool('file', ['-b', binary_path]),
      runTool('readelf', ['-h', binary_path]).catch(() => ({ success: false, stdout: '', stderr: '' })),
      runTool('sha256sum', [binary_path])
    ]);

    const parsed = parseLinuxBinaryInfo(fileResult, readelfResult, sha256Result, binary_path);
    return textContent(JSON.stringify(parsed, null, 2));
  }
);

/**
 * die_scan — Detect It Easy(DiE)로 패킹/난독화/컴파일러/런타임 탐지
 */
server.tool(
  'die_scan',
  'Detect It Easy(DiE)로 패킹/난독화/컴파일러/런타임 탐지',
  z.object({ binary_path: z.string().describe('분석할 바이너리 파일 경로') }),
  async ({ binary_path }) => {
    if (!existsSync(binary_path)) {
      return textContent(`Error: File not found: ${binary_path}`);
    }

    const result = await runTool(DIE_PATH, ['--json', binary_path], { timeout: 120000 });

    if (!result.success && !result.stdout) {
      return textContent(`DiE scan failed: ${result.error}\n${result.stderr}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (e) {
      parsed = { raw_output: result.stdout };
    }

    return textContent(JSON.stringify(parsed, null, 2));
  }
);

/**
 * binary_info — 바이너리 구조 상세 정보
 */
server.tool(
  'binary_info',
  '바이너리 구조 상세 정보 (Windows: DiE deep, Linux: readelf + DiE)',
  z.object({ binary_path: z.string().describe('분석할 바이너리 파일 경로') }),
  async ({ binary_path }) => {
    if (!existsSync(binary_path)) {
      return textContent(`Error: File not found: ${binary_path}`);
    }

    if (IS_WINDOWS) {
      const result = await runTool(DIE_PATH, ['--json', '--deep', binary_path], { timeout: 120000 });

      if (!result.success && !result.stdout) {
        const fallback = await runTool(SIGCHECK_PATH, ['-nobanner', '-accepteula', binary_path]);
        return textContent(JSON.stringify({
          source: 'sigcheck_fallback',
          raw_output: fallback.stdout || fallback.stderr || 'No output',
          filename: basename(binary_path)
        }, null, 2));
      }

      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch (e) {
        parsed = { raw_output: result.stdout };
      }

      return textContent(JSON.stringify({ source: 'die_deep', filename: basename(binary_path), ...parsed }, null, 2));
    }

    const [sectionsResult, dynamicResult, dieResult] = await Promise.all([
      runTool('readelf', ['-S', '-W', binary_path]),
      runTool('readelf', ['-d', binary_path]).catch(() => ({ success: false, stdout: '' })),
      runTool(DIE_PATH, ['--json', '--deep', binary_path], { timeout: 120000 })
        .catch(() => ({ success: false, stdout: '' }))
    ]);

    const info = {
      source: 'readelf',
      filename: basename(binary_path),
      sections: sectionsResult.success ? sectionsResult.stdout : 'readelf -S failed',
      dynamic_deps: dynamicResult.success ? parseDynamicDeps(dynamicResult.stdout) : []
    };

    if (dieResult.success && dieResult.stdout) {
      try {
        info.die_deep = JSON.parse(dieResult.stdout);
      } catch (e) {
        info.die_deep_raw = dieResult.stdout;
      }
    }

    return textContent(JSON.stringify(info, null, 2));
  }
);

/**
 * [목적] Sigcheck 텍스트 출력을 구조화된 JSON으로 파싱 (Windows).
 */
function parseSigcheckOutput(output, filePath) {
  const result = {
    file: basename(filePath),
    path: filePath,
    format: 'PE',
    verified: 'Unknown',
    signing_date: '',
    publisher: '',
    company: '',
    description: '',
    product: '',
    product_version: '',
    file_version: '',
    machine_type: '',
    md5: '',
    sha1: '',
    sha256: '',
    raw_output: output
  };

  const lines = output.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.substring(0, colonIdx).trim().toLowerCase();
    const value = trimmed.substring(colonIdx + 1).trim();

    switch (key) {
      case 'verified': result.verified = value; break;
      case 'signing date': result.signing_date = value; break;
      case 'publisher': result.publisher = value; break;
      case 'company': result.company = value; break;
      case 'description': result.description = value; break;
      case 'product': result.product = value; break;
      case 'prod version': result.product_version = value; break;
      case 'file version': result.file_version = value; break;
      case 'machinetype': result.machine_type = value; break;
      case 'md5': result.md5 = value; break;
      case 'sha1': result.sha1 = value; break;
      case 'sha256': result.sha256 = value; break;
    }
  }

  return result;
}

/**
 * [목적] Linux file + readelf + sha256sum 출력을 구조화된 JSON으로 파싱.
 */
function parseLinuxBinaryInfo(fileResult, readelfResult, sha256Result, filePath) {
  const result = {
    file: basename(filePath),
    path: filePath,
    format: 'Unknown',
    verified: 'N/A (Linux)',
    signing_date: '',
    publisher: '',
    company: '',
    description: '',
    product: '',
    product_version: '',
    file_version: '',
    machine_type: '',
    md5: '',
    sha1: '',
    sha256: '',
    elf_type: '',
    elf_class: '',
    elf_entry_point: ''
  };

  if (fileResult.success) {
    const fileOut = fileResult.stdout;
    result.description = fileOut;

    if (fileOut.includes('ELF')) {
      result.format = 'ELF';
      if (fileOut.includes('x86-64') || fileOut.includes('x86_64')) result.machine_type = 'x86_64';
      else if (fileOut.includes('80386') || fileOut.includes('Intel 80386')) result.machine_type = 'x86 (32-bit)';
      else if (fileOut.includes('ARM aarch64') || fileOut.includes('aarch64')) result.machine_type = 'aarch64';
      else if (fileOut.includes('ARM')) result.machine_type = 'ARM';
      else if (fileOut.includes('MIPS')) result.machine_type = 'MIPS';

      if (fileOut.includes('executable')) result.elf_type = 'EXEC';
      else if (fileOut.includes('shared object')) result.elf_type = 'DYN (shared object/PIE)';
      else if (fileOut.includes('relocatable')) result.elf_type = 'REL';
      else if (fileOut.includes('core file')) result.elf_type = 'CORE';

      if (fileOut.includes('statically linked')) result.product = 'statically linked';
      else if (fileOut.includes('dynamically linked')) result.product = 'dynamically linked';

      if (fileOut.includes('not stripped')) result.file_version = 'not stripped (symbols available)';
      else if (fileOut.includes('stripped')) result.file_version = 'stripped';
    } else if (fileOut.includes('PE32+') || fileOut.includes('PE32')) {
      result.format = 'PE';
      if (fileOut.includes('PE32+')) result.machine_type = 'x86_64';
      else result.machine_type = 'x86 (32-bit)';
    } else if (fileOut.includes('Mach-O')) {
      result.format = 'Mach-O';
    }
  }

  if (readelfResult.success && readelfResult.stdout) {
    const lines = readelfResult.stdout.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('Class:')) result.elf_class = trimmed.split(':')[1]?.trim() || '';
      else if (trimmed.startsWith('Machine:')) {
        const m = trimmed.split(':')[1]?.trim() || '';
        if (m) result.machine_type = m;
      }
      else if (trimmed.startsWith('Entry point address:')) result.elf_entry_point = trimmed.split(':')[1]?.trim() || '';
      else if (trimmed.startsWith('Type:')) result.elf_type = trimmed.split(':')[1]?.trim() || '';
    }
  }

  if (sha256Result.success && sha256Result.stdout) {
    const parts = sha256Result.stdout.split(/\s+/);
    if (parts[0]) result.sha256 = parts[0];
  }

  return result;
}

/**
 * [목적] readelf -d 출력에서 NEEDED 공유 라이브러리 추출.
 */
function parseDynamicDeps(output) {
  const deps = [];
  const lines = output.split('\n');
  for (const line of lines) {
    const match = line.match(/\(NEEDED\)\s+Shared library:\s+\[(.+?)]/);
    if (match) deps.push(match[1]);
  }
  return deps;
}

// stdio 전송으로 MCP 서버 시작
const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error(err);
  process.exit(1);
});
