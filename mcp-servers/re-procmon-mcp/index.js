#!/usr/bin/env node
/**
 * RE Process Monitor MCP Server
 *
 * 프로세스 행위 추적을 위한 MCP 도구 서버.
 * - Linux: strace (syscall 트레이싱)
 * - Windows: ProcMon CLI (Procmon64.exe)
 * 관찰 중심(Observation-Only): 프로세스를 수정하지 않고 행위만 기록한다.
 */
import { McpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

const IS_WINDOWS = process.platform === 'win32';
const STRACE_PATH = process.env.STRACE_PATH || 'strace';
const PROCMON_PATH = process.env.PROCMON_PATH || 'Procmon64.exe';
const OUTPUT_DIR = process.env.PROCMON_OUTPUT_DIR || join(tmpdir(), 'dokodemodoor-procmon');

// 출력 디렉토리 확보
if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 활성 캡처 세션 관리
const activeSessions = new Map();

/**
 * [목적] strace syscall 카테고리별 필터 매핑.
 */
const STRACE_FILTERS = {
  all: '',
  file: 'trace=open,openat,close,read,write,stat,fstat,lstat,access,unlink,rename,mkdir,rmdir,creat,chmod,chown,link,symlink,readlink',
  network: 'trace=socket,connect,accept,bind,listen,sendto,recvfrom,sendmsg,recvmsg,send,recv,getsockopt,setsockopt,getpeername,getsockname',
  process: 'trace=fork,vfork,clone,execve,wait4,waitpid,kill,exit,exit_group',
  memory: 'trace=mmap,munmap,mprotect,brk,mlock,mlockall',
  registry: 'trace=open,openat,read,write',  // Linux에서 레지스트리는 파일 접근에 매핑
  signal: 'trace=signal,rt_sigaction,rt_sigprocmask,rt_sigreturn,kill,tgkill'
};

/**
 * [목적] strace 출력을 구조화된 이벤트 배열로 파싱.
 *
 * @param {string} rawOutput - strace 원시 출력
 * @param {number} limit - 최대 이벤트 수
 * @returns {Array} 파싱된 이벤트 배열
 */
function parseStraceOutput(rawOutput, limit = 500) {
  const lines = rawOutput.split('\n').filter(l => l.trim());
  const events = [];

  // strace 출력 형식: PID  syscall(args) = result
  const lineRegex = /^\[?(\d+)\]?\s*[\d:.]*\s*(\w+)\(([^)]*)\)\s*=\s*(.+)$/;
  const unfinishedRegex = /^\[?(\d+)\]?\s*[\d:.]*\s*(\w+)\(([^)]*)\s*<unfinished\s*\.\.\.>$/;

  for (const line of lines) {
    if (events.length >= limit) break;

    let match = line.match(lineRegex);
    if (match) {
      events.push({
        pid: parseInt(match[1]),
        syscall: match[2],
        args: match[3].substring(0, 200),  // 인자 길이 제한
        result: match[4].trim(),
        raw: line.substring(0, 300)
      });
      continue;
    }

    // 타임스탬프 포함 형식: PID  HH:MM:SS.us syscall(args) = result
    const tsRegex = /^\[?(\d+)\]?\s+([\d:.]+)\s+(\w+)\(([^)]*)\)\s*=\s*(.+)$/;
    match = line.match(tsRegex);
    if (match) {
      events.push({
        pid: parseInt(match[1]),
        timestamp: match[2],
        syscall: match[3],
        args: match[4].substring(0, 200),
        result: match[5].trim(),
        raw: line.substring(0, 300)
      });
    }
  }

  return events;
}

/**
 * [목적] 이벤트 요약 통계 생성.
 */
function summarizeEvents(events) {
  const syscallCounts = {};
  const pidSet = new Set();

  for (const evt of events) {
    syscallCounts[evt.syscall] = (syscallCounts[evt.syscall] || 0) + 1;
    pidSet.add(evt.pid);
  }

  // 상위 syscall 정렬
  const topSyscalls = Object.entries(syscallCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  return {
    total_events: events.length,
    unique_pids: pidSet.size,
    pids: Array.from(pidSet),
    top_syscalls: topSyscalls
  };
}

const server = new McpServer({
  name: 're-procmon',
  version: '1.0.0',
  description: 'Process behavior tracing: strace (Linux) / ProcMon (Windows)'
});

/**
 * procmon_start_capture — 프로세스 행위 캡처 시작
 */
server.tool(
  'procmon_start_capture',
  {
    target: z.string().describe('대상 프로세스 (실행 파일 경로 또는 PID)'),
    target_type: z.enum(['command', 'pid']).optional().describe('target 유형 (기본: command)'),
    filter: z.enum(['all', 'file', 'network', 'process', 'memory', 'signal']).optional().describe('캡처 필터 (기본: all)'),
    follow_forks: z.boolean().optional().describe('자식 프로세스도 추적 (기본: true)'),
    duration: z.number().optional().describe('캡처 시간 (초, 기본: 30)'),
    args: z.array(z.string()).optional().describe('대상 프로세스 실행 인자 (command 모드)')
  },
  async ({ target, target_type, filter, follow_forks, duration, args: procArgs }) => {
    const sessionId = randomUUID().substring(0, 8);
    const outputFile = join(OUTPUT_DIR, `strace-${sessionId}.log`);
    const filterType = filter || 'all';
    const maxDuration = duration || 30;
    const forkFlag = follow_forks !== false;
    const mode = target_type || 'command';

    if (IS_WINDOWS) {
      return { content: [{ type: 'text', text: JSON.stringify({
        error: 'ProcMon CLI 모드는 아직 미구현. Linux strace를 사용하세요.',
        platform: 'windows'
      }, null, 2) }] };
    }

    try {
      const straceArgs = [];

      // 시간 정보 포함
      straceArgs.push('-t');

      // 자식 프로세스 추적
      if (forkFlag) straceArgs.push('-f');

      // syscall 필터
      const traceFilter = STRACE_FILTERS[filterType];
      if (traceFilter) straceArgs.push('-e', traceFilter);

      // 출력 파일
      straceArgs.push('-o', outputFile);

      // 대상 지정
      if (mode === 'pid') {
        straceArgs.push('-p', target);
      } else {
        straceArgs.push(target);
        if (procArgs && procArgs.length > 0) {
          straceArgs.push(...procArgs);
        }
      }

      // strace 비동기 실행
      const straceProc = spawn(STRACE_PATH, straceArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      });

      // 타임아웃 설정
      const timeoutId = setTimeout(() => {
        if (straceProc.pid) {
          process.kill(-straceProc.pid, 'SIGINT');
        }
      }, maxDuration * 1000);

      // 세션 저장
      activeSessions.set(sessionId, {
        process: straceProc,
        timeoutId,
        outputFile,
        filter: filterType,
        target,
        startTime: new Date().toISOString(),
        status: 'running'
      });

      // 프로세스 종료 핸들링
      straceProc.on('exit', (code) => {
        clearTimeout(timeoutId);
        const session = activeSessions.get(sessionId);
        if (session) {
          session.status = 'completed';
          session.exitCode = code;
          session.endTime = new Date().toISOString();
        }
      });

      straceProc.on('error', (err) => {
        clearTimeout(timeoutId);
        const session = activeSessions.get(sessionId);
        if (session) {
          session.status = 'error';
          session.error = err.message;
        }
      });

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        session_id: sessionId,
        output_file: outputFile,
        filter: filterType,
        target,
        mode,
        follow_forks: forkFlag,
        max_duration_seconds: maxDuration,
        message: `캡처 시작됨. ${maxDuration}초 후 자동 종료. procmon_stop_capture 또는 procmon_get_events로 결과 확인.`
      }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({
        success: false,
        error: error.message,
        hint: 'strace가 설치되어 있는지 확인하세요: sudo apt install strace'
      }, null, 2) }] };
    }
  }
);

/**
 * procmon_stop_capture — 활성 캡처 중지 + 결과 요약 반환
 */
server.tool(
  'procmon_stop_capture',
  {
    session_id: z.string().describe('캡처 세션 ID (procmon_start_capture에서 반환)')
  },
  async ({ session_id }) => {
    const session = activeSessions.get(session_id);
    if (!session) {
      return { content: [{ type: 'text', text: JSON.stringify({
        error: `세션 ${session_id}을 찾을 수 없습니다.`,
        active_sessions: Array.from(activeSessions.keys())
      }, null, 2) }] };
    }

    // 프로세스 중지
    if (session.status === 'running' && session.process?.pid) {
      try {
        clearTimeout(session.timeoutId);
        process.kill(session.process.pid, 'SIGINT');
        // 중지 후 잠시 대기
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (e) {
        // 이미 종료된 경우 무시
      }
    }

    session.status = 'stopped';
    session.endTime = new Date().toISOString();

    // 결과 파일 읽기
    let summary = { total_events: 0 };
    if (existsSync(session.outputFile)) {
      const rawOutput = readFileSync(session.outputFile, 'utf8');
      const events = parseStraceOutput(rawOutput);
      summary = summarizeEvents(events);
    }

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      session_id,
      status: 'stopped',
      output_file: session.outputFile,
      start_time: session.startTime,
      end_time: session.endTime,
      summary,
      message: 'procmon_get_events로 상세 이벤트를 조회할 수 있습니다.'
    }, null, 2) }] };
  }
);

/**
 * procmon_get_events — 캡처된 이벤트 조회 및 필터링
 */
server.tool(
  'procmon_get_events',
  {
    session_id: z.string().describe('캡처 세션 ID'),
    syscall_filter: z.string().optional().describe('syscall 이름 필터 (정규식 패턴)'),
    path_filter: z.string().optional().describe('파일/소켓 경로 필터 (정규식 패턴)'),
    pid_filter: z.number().optional().describe('특정 PID만 필터'),
    limit: z.number().optional().describe('최대 이벤트 수 (기본: 200)')
  },
  async ({ session_id, syscall_filter, path_filter, pid_filter, limit }) => {
    const session = activeSessions.get(session_id);
    const maxEvents = limit || 200;

    // 세션이 없으면 파일 경로 직접 시도
    const outputFile = session?.outputFile || join(OUTPUT_DIR, `strace-${session_id}.log`);

    if (!existsSync(outputFile)) {
      return { content: [{ type: 'text', text: JSON.stringify({
        error: `캡처 파일을 찾을 수 없습니다: ${outputFile}`,
        session_status: session?.status || 'unknown'
      }, null, 2) }] };
    }

    const rawOutput = readFileSync(outputFile, 'utf8');
    let events = parseStraceOutput(rawOutput, 5000); // 파싱은 최대 5000개

    // 필터 적용
    if (syscall_filter) {
      const regex = new RegExp(syscall_filter, 'i');
      events = events.filter(e => regex.test(e.syscall));
    }
    if (path_filter) {
      const regex = new RegExp(path_filter, 'i');
      events = events.filter(e => regex.test(e.args) || regex.test(e.raw));
    }
    if (pid_filter) {
      events = events.filter(e => e.pid === pid_filter);
    }

    const summary = summarizeEvents(events);
    const returnEvents = events.slice(0, maxEvents);

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      session_id,
      filter_applied: {
        syscall: syscall_filter || null,
        path: path_filter || null,
        pid: pid_filter || null
      },
      summary,
      events_returned: returnEvents.length,
      events_total: events.length,
      events: returnEvents
    }, null, 2) }] };
  }
);

/**
 * procmon_set_filter — 캡처 필터 프리셋 조회 또는 커스텀 필터 생성
 */
server.tool(
  'procmon_set_filter',
  {
    action: z.enum(['list_presets', 'create_custom']).describe('list_presets: 프리셋 목록 조회, create_custom: 커스텀 필터'),
    syscalls: z.array(z.string()).optional().describe('커스텀 syscall 목록 (create_custom 시)'),
    name: z.string().optional().describe('커스텀 필터 이름')
  },
  async ({ action, syscalls, name }) => {
    if (action === 'list_presets') {
      const presets = Object.entries(STRACE_FILTERS).map(([key, value]) => ({
        name: key,
        strace_args: value || '(모든 syscall)',
        description: {
          all: '모든 syscall 추적',
          file: '파일 I/O 관련 syscall',
          network: '네트워크 관련 syscall (socket, connect, send, recv...)',
          process: '프로세스 관리 (fork, exec, wait, kill...)',
          memory: '메모리 관리 (mmap, mprotect, brk...)',
          signal: '시그널 관련 syscall'
        }[key]
      }));

      return { content: [{ type: 'text', text: JSON.stringify({
        presets,
        usage: 'procmon_start_capture의 filter 파라미터로 프리셋 이름 전달'
      }, null, 2) }] };
    }

    // 커스텀 필터 생성
    if (syscalls && syscalls.length > 0) {
      const filterStr = `trace=${syscalls.join(',')}`;
      const filterName = name || `custom_${randomUUID().substring(0, 6)}`;

      // 런타임에 필터 추가
      STRACE_FILTERS[filterName] = filterStr;

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        filter_name: filterName,
        strace_args: filterStr,
        syscalls,
        message: `커스텀 필터 '${filterName}' 생성됨. procmon_start_capture에서 filter 파라미터로 사용 가능.`
      }, null, 2) }] };
    }

    return { content: [{ type: 'text', text: 'syscalls 파라미터를 제공하세요.' }] };
  }
);

// Start server
server.run({ transport: 'stdio' }).catch(console.error);
