#!/usr/bin/env node
/**
 * RE Debugger MCP Server
 *
 * 디버거 기반 동적 관찰을 위한 MCP 도구 서버.
 * - Linux: gdb (GDB/MI 인터페이스)
 * - Windows: CDB (Console Debugger)
 * 관찰 중심: 브레이크포인트 설정, 모듈/스레드 조회, 크래시 캡처.
 */
import { McpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const IS_WINDOWS = process.platform === 'win32';
const GDB_PATH = process.env.DEBUGGER_PATH || (IS_WINDOWS ? 'cdb' : 'gdb');
const OUTPUT_DIR = process.env.DEBUGGER_OUTPUT_DIR || join(tmpdir(), 'dokodemodoor-debugger');

if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 활성 디버거 세션
let activeSession = null;

/**
 * [목적] GDB/MI 세션 관리 클래스.
 *
 * gdb --interpreter=mi 모드로 구조화된 입출력을 처리한다.
 * MI 출력 접두사:
 *   ~ "console output"
 *   & "log output"
 *   * "async exec record"
 *   = "async notify record"
 *   ^ "result record" (done, running, error)
 */
class GdbSession {
  constructor() {
    this.process = null;
    this.pid = null;
    this.target = null;
    this.buffer = '';
    this.ready = false;
    this.sessionId = randomUUID().substring(0, 8);
    this.breakpoints = [];
    this.exceptions = [];
  }

  /**
   * [목적] gdb/MI 세션 시작 및 프로세스 연결.
   */
  async attach(target, targetType = 'pid') {
    return new Promise((resolve, reject) => {
      const gdbArgs = ['--interpreter=mi', '--quiet'];

      if (targetType === 'pid') {
        gdbArgs.push('-p', String(target));
      }

      this.process = spawn(GDB_PATH, gdbArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.target = target;
      let initOutput = '';

      const onData = (data) => {
        initOutput += data.toString();
        // gdb/MI 초기화 완료 신호: (gdb) 또는 ^done
        if (initOutput.includes('(gdb)') || initOutput.includes('^done')) {
          this.ready = true;
          this.process.stdout.removeListener('data', onData);
          resolve({
            success: true,
            session_id: this.sessionId,
            target,
            target_type: targetType,
            debugger: IS_WINDOWS ? 'cdb' : 'gdb/MI'
          });
        }
      };

      this.process.stdout.on('data', onData);

      this.process.on('error', (err) => {
        reject(new Error(`디버거 시작 실패: ${err.message}`));
      });

      // 타임아웃
      setTimeout(() => {
        if (!this.ready) {
          this.process.stdout.removeListener('data', onData);
          // 초기화 출력이라도 반환
          resolve({
            success: true,
            session_id: this.sessionId,
            target,
            target_type: targetType,
            debugger: IS_WINDOWS ? 'cdb' : 'gdb/MI',
            warning: '초기화 지연 — 명령은 정상 전송 가능'
          });
        }
      }, 10000);

      // command 모드: 파일을 직접 로드
      if (targetType === 'command' && !IS_WINDOWS) {
        // gdb가 시작된 후 file 명령으로 로드
        setTimeout(() => {
          if (this.process.stdin.writable) {
            this.process.stdin.write(`-file-exec-and-symbols ${target}\n`);
          }
        }, 2000);
      }
    });
  }

  /**
   * [목적] gdb/MI 명령 실행 및 결과 수집.
   *
   * @param {string} command - gdb 명령 (일반 CLI 또는 MI 명령)
   * @param {number} timeout - 응답 대기 시간(ms)
   * @returns {Promise<string>} 명령 결과
   */
  async execute(command, timeout = 15000) {
    if (!this.process || !this.process.stdin.writable) {
      throw new Error('디버거 세션이 활성 상태가 아닙니다.');
    }

    return new Promise((resolve, reject) => {
      let output = '';
      let timer;

      const onData = (data) => {
        output += data.toString();
        // MI 결과 레코드 완료 판단
        if (output.includes('^done') || output.includes('^error') ||
            output.includes('^running') || output.includes('(gdb)')) {
          clearTimeout(timer);
          this.process.stdout.removeListener('data', onData);
          resolve(output);
        }
      };

      this.process.stdout.on('data', onData);

      timer = setTimeout(() => {
        this.process.stdout.removeListener('data', onData);
        resolve(output || '(타임아웃 — 응답 없음)');
      }, timeout);

      // MI 명령 전송 (CLI 명령은 -interpreter-exec console "cmd" 형식)
      const isCliCommand = !command.startsWith('-');
      const miCommand = isCliCommand
        ? `-interpreter-exec console "${command.replace(/"/g, '\\"')}"\n`
        : `${command}\n`;

      this.process.stdin.write(miCommand);
    });
  }

  /**
   * [목적] 세션 정리 및 디버거 종료.
   */
  async detach() {
    if (this.process && this.process.stdin.writable) {
      try {
        this.process.stdin.write('-gdb-exit\n');
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (e) {
        // 무시
      }
      this.process.kill('SIGTERM');
    }
    this.ready = false;
    this.process = null;
  }
}

/**
 * [목적] gdb/MI 출력에서 유용한 텍스트만 추출.
 */
function cleanMiOutput(raw) {
  return raw
    .split('\n')
    .filter(line => line.startsWith('~'))  // console output
    .map(line => {
      // ~"text\n" 형식에서 text 추출
      const match = line.match(/^~"(.*)"$/);
      return match ? match[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"') : line;
    })
    .join('')
    .trim();
}

const server = new McpServer({
  name: 're-windbg',
  version: '1.0.0',
  description: 'Debugger-based observation: gdb/MI (Linux) / CDB (Windows)'
});

/**
 * cdb_attach_process — 디버거를 프로세스에 연결
 */
server.tool(
  'cdb_attach_process',
  {
    target: z.string().describe('PID (숫자) 또는 실행 파일 경로'),
    target_type: z.enum(['pid', 'command']).optional().describe('pid: 실행 중 프로세스 연결, command: 새 프로세스 시작 (기본: pid)')
  },
  async ({ target, target_type }) => {
    // 기존 세션 정리
    if (activeSession) {
      await activeSession.detach();
      activeSession = null;
    }

    const session = new GdbSession();
    try {
      const result = await session.attach(target, target_type || 'pid');
      activeSession = session;

      return { content: [{ type: 'text', text: JSON.stringify({
        ...result,
        message: '디버거 연결 완료. cdb_run_command로 명령을 실행하세요.',
        platform: IS_WINDOWS ? 'windows/cdb' : 'linux/gdb'
      }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({
        success: false,
        error: error.message,
        hint: IS_WINDOWS
          ? 'CDB가 설치되어 있는지 확인하세요.'
          : 'gdb가 설치되어 있는지 확인하세요: sudo apt install gdb\nptrace 권한: echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope'
      }, null, 2) }] };
    }
  }
);

/**
 * cdb_run_command — 디버거 명령 실행
 */
server.tool(
  'cdb_run_command',
  {
    command: z.string().describe('gdb/CDB 명령 (예: "info registers", "x/10i $pc", "bt")'),
    timeout: z.number().optional().describe('응답 대기 시간(ms, 기본: 15000)')
  },
  async ({ command, timeout }) => {
    if (!activeSession) {
      return { content: [{ type: 'text', text: 'Error: 활성 세션 없음. cdb_attach_process를 먼저 실행하세요.' }] };
    }

    try {
      const rawOutput = await activeSession.execute(command, timeout || 15000);
      const cleanOutput = cleanMiOutput(rawOutput);

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        command,
        output: cleanOutput || rawOutput.substring(0, 5000),
        raw_length: rawOutput.length
      }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({
        success: false,
        command,
        error: error.message
      }, null, 2) }] };
    }
  }
);

/**
 * cdb_set_breakpoint — 브레이크포인트 설정
 */
server.tool(
  'cdb_set_breakpoint',
  {
    location: z.string().describe('브레이크포인트 위치 (함수명 또는 0x주소)'),
    condition: z.string().optional().describe('조건식 (gdb: "if expr", CDB: 조건 표현식)'),
    commands: z.string().optional().describe('브레이크포인트 히트 시 실행할 명령 (예: "bt\\ncontinue")')
  },
  async ({ location, condition, commands }) => {
    if (!activeSession) {
      return { content: [{ type: 'text', text: 'Error: 활성 세션 없음. cdb_attach_process를 먼저 실행하세요.' }] };
    }

    try {
      // 브레이크포인트 설정
      let bpCommand = `break ${location}`;
      if (condition) bpCommand += ` if ${condition}`;

      const bpResult = await activeSession.execute(bpCommand);

      // 히트 시 명령 설정
      if (commands) {
        // gdb: 마지막 설정된 bp 번호를 추출하여 commands 설정
        const bpMatch = bpResult.match(/Breakpoint (\d+)/);
        if (bpMatch) {
          const bpNum = bpMatch[1];
          const cmdLines = commands.split('\\n');
          await activeSession.execute(`commands ${bpNum}`);
          for (const cmd of cmdLines) {
            await activeSession.execute(cmd);
          }
          await activeSession.execute('end');
        }
      }

      activeSession.breakpoints.push({
        location,
        condition: condition || null,
        commands: commands || null
      });

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        location,
        condition: condition || null,
        total_breakpoints: activeSession.breakpoints.length,
        output: cleanMiOutput(bpResult) || bpResult.substring(0, 1000)
      }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({
        success: false,
        error: error.message
      }, null, 2) }] };
    }
  }
);

/**
 * cdb_list_modules — 로드된 모듈(공유 라이브러리) 목록
 */
server.tool(
  'cdb_list_modules',
  {},
  async () => {
    if (!activeSession) {
      return { content: [{ type: 'text', text: 'Error: 활성 세션 없음.' }] };
    }

    const command = IS_WINDOWS ? 'lm' : 'info sharedlibrary';
    const rawOutput = await activeSession.execute(command);
    const output = cleanMiOutput(rawOutput) || rawOutput.substring(0, 5000);

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      command,
      modules: output
    }, null, 2) }] };
  }
);

/**
 * cdb_list_threads — 스레드 목록 + 콜스택
 */
server.tool(
  'cdb_list_threads',
  {
    include_backtrace: z.boolean().optional().describe('각 스레드의 백트레이스 포함 (기본: true)')
  },
  async ({ include_backtrace }) => {
    if (!activeSession) {
      return { content: [{ type: 'text', text: 'Error: 활성 세션 없음.' }] };
    }

    const withBt = include_backtrace !== false;
    const command = IS_WINDOWS
      ? (withBt ? '~*k' : '~*')
      : (withBt ? 'thread apply all bt' : 'info threads');

    const rawOutput = await activeSession.execute(command, 30000);
    const output = cleanMiOutput(rawOutput) || rawOutput.substring(0, 8000);

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      command,
      include_backtrace: withBt,
      threads: output
    }, null, 2) }] };
  }
);

/**
 * cdb_list_exceptions — 예외/시그널 이벤트 로그
 */
server.tool(
  'cdb_list_exceptions',
  {},
  async () => {
    if (!activeSession) {
      return { content: [{ type: 'text', text: 'Error: 활성 세션 없음.' }] };
    }

    // gdb: 시그널 핸들링 상태 조회
    const command = IS_WINDOWS ? '.exr -1' : 'info signals';
    const rawOutput = await activeSession.execute(command);
    const output = cleanMiOutput(rawOutput) || rawOutput.substring(0, 5000);

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      command,
      exceptions_log: activeSession.exceptions,
      signal_info: output
    }, null, 2) }] };
  }
);

/**
 * cdb_capture_crash — 크래시 덤프 캡처
 */
server.tool(
  'cdb_capture_crash',
  {
    output_path: z.string().optional().describe('코어 덤프 저장 경로')
  },
  async ({ output_path }) => {
    if (!activeSession) {
      return { content: [{ type: 'text', text: 'Error: 활성 세션 없음.' }] };
    }

    const dumpFile = output_path || join(OUTPUT_DIR, `crash-${activeSession.sessionId}.core`);

    try {
      const command = IS_WINDOWS
        ? `.dump /ma ${dumpFile}`
        : `generate-core-file ${dumpFile}`;

      const rawOutput = await activeSession.execute(command, 30000);
      const output = cleanMiOutput(rawOutput) || rawOutput.substring(0, 2000);

      // 추가 정보: 레지스터, 백트레이스
      const regsOutput = await activeSession.execute('info registers');
      const btOutput = await activeSession.execute('bt');

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        dump_file: dumpFile,
        dump_output: output,
        registers: cleanMiOutput(regsOutput) || regsOutput.substring(0, 2000),
        backtrace: cleanMiOutput(btOutput) || btOutput.substring(0, 3000)
      }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({
        success: false,
        error: error.message
      }, null, 2) }] };
    }
  }
);

// 정리: 프로세스 종료 시 디버거 세션 해제
process.on('SIGINT', async () => {
  if (activeSession) await activeSession.detach();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  if (activeSession) await activeSession.detach();
  process.exit(0);
});

// Start server
server.run({ transport: 'stdio' }).catch(console.error);
