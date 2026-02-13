#!/usr/bin/env node
/**
 * RE Frida Instrumentation MCP Server
 *
 * Frida를 활용한 런타임 계측 MCP 도구 서버.
 * observation_candidates.json의 후보 함수에 자동으로 훅을 설치하여
 * 인자, 반환값, 콜스택을 로깅한다.
 *
 * 관찰 중심(Observation-Only): 바이너리를 수정하지 않고 런타임 행위만 기록.
 */
import { McpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { randomUUID } from 'crypto';

// Frida는 런타임에서 동적 로드 (네이티브 빌드 의존성)
let frida;
try {
  frida = await import('frida');
} catch (e) {
  frida = null;
}

// 세션 상태
let fridaSession = null;
let fridaScript = null;
let hookLogs = [];
let installedHooks = new Map();

/**
 * [목적] Frida 훅 스크립트 생성기.
 *
 * @param {string} moduleName - 모듈 이름 (예: libc.so.6)
 * @param {string} functionName - 함수 이름
 * @param {string[]} logTypes - 로깅 유형 배열 (entry_args, return_value, callstack)
 * @returns {string} Frida JavaScript 스크립트
 */
function generateHookScript(moduleName, functionName, logTypes = ['entry_args', 'return_value']) {
  const logArgs = logTypes.includes('entry_args');
  const logRet = logTypes.includes('return_value');
  const logStack = logTypes.includes('callstack');

  return `
(function() {
  var target = Module.findExportByName(${moduleName ? `"${moduleName}"` : 'null'}, "${functionName}");
  if (!target) {
    send({ type: 'error', function: '${functionName}', message: 'Function not found' });
    return;
  }

  Interceptor.attach(target, {
    onEnter: function(args) {
      var entry = {
        type: 'hook_event',
        event: 'enter',
        function: '${functionName}',
        module: '${moduleName || 'unknown'}',
        timestamp: Date.now(),
        tid: Process.getCurrentThreadId()
      };
      ${logArgs ? `
      entry.args = [];
      for (var i = 0; i < Math.min(args.length, 6); i++) {
        try {
          entry.args.push(args[i].toString());
        } catch(e) {
          entry.args.push('(unreadable)');
        }
      }` : ''}
      ${logStack ? `
      entry.callstack = Thread.backtrace(this.context, Backtracer.ACCURATE)
        .map(DebugSymbol.fromAddress)
        .filter(function(s) { return s.name; })
        .slice(0, 10)
        .map(function(s) { return s.name + ' (' + s.address + ')'; });` : ''}
      this._entryData = entry;
      send(entry);
    }${logRet ? `,
    onLeave: function(retval) {
      send({
        type: 'hook_event',
        event: 'leave',
        function: '${functionName}',
        module: '${moduleName || 'unknown'}',
        timestamp: Date.now(),
        tid: Process.getCurrentThreadId(),
        return_value: retval.toString()
      });
    }` : ''}
  });

  send({ type: 'hook_installed', function: '${functionName}', module: '${moduleName || 'unknown'}', address: target.toString() });
})();
`;
}

/**
 * [목적] 모듈 열거 스크립트.
 */
const LIST_MODULES_SCRIPT = `
var modules = Process.enumerateModules();
var result = modules.map(function(m) {
  return { name: m.name, base: m.base.toString(), size: m.size, path: m.path };
});
send({ type: 'modules', data: result });
`;

/**
 * [목적] 모듈 export 열거 스크립트.
 */
function listExportsScript(moduleName) {
  return `
var exports = Module.enumerateExports("${moduleName}");
var result = exports.slice(0, 500).map(function(e) {
  return { name: e.name, type: e.type, address: e.address.toString() };
});
send({ type: 'exports', module: '${moduleName}', count: exports.length, data: result });
`;
}

const server = new McpServer({
  name: 're-frida',
  version: '1.0.0',
  description: 'Runtime instrumentation via Frida: hook, trace, log function calls'
});

/**
 * frida_attach — 프로세스에 Frida 연결
 */
server.tool(
  'frida_attach',
  {
    target: z.string().describe('프로세스 PID (숫자) 또는 프로세스 이름'),
    target_type: z.enum(['pid', 'name']).optional().describe('pid 또는 name (기본: 자동 감지)')
  },
  async ({ target, target_type }) => {
    if (!frida) {
      return { content: [{ type: 'text', text: JSON.stringify({
        success: false,
        error: 'frida 모듈이 설치되지 않았습니다.',
        hint: 'cd mcp-servers/re-frida-mcp && npm install'
      }, null, 2) }] };
    }

    // 기존 세션 정리
    if (fridaSession) {
      try { await fridaSession.detach(); } catch (e) { /* ignore */ }
      fridaSession = null;
      fridaScript = null;
      hookLogs = [];
      installedHooks.clear();
    }

    try {
      const device = await frida.getLocalDevice();
      const isPid = /^\d+$/.test(target);
      const mode = target_type || (isPid ? 'pid' : 'name');

      if (mode === 'pid') {
        fridaSession = await device.attach(parseInt(target));
      } else {
        fridaSession = await device.attach(target);
      }

      hookLogs = [];
      installedHooks.clear();

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        target,
        target_type: mode,
        session_pid: fridaSession.pid,
        message: 'Frida 연결 성공. frida_hook_function으로 훅을 설치하세요.'
      }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({
        success: false,
        error: error.message,
        hint: 'frida-server가 실행 중인지 확인하세요. 또는 sudo 권한이 필요할 수 있습니다.'
      }, null, 2) }] };
    }
  }
);

/**
 * frida_hook_function — 함수 훅 설치
 */
server.tool(
  'frida_hook_function',
  {
    function_name: z.string().describe('훅할 함수 이름 (예: connect, SSL_write)'),
    module_name: z.string().optional().describe('모듈 이름 (예: libc.so.6, libssl.so). 생략 시 전역 검색'),
    log_types: z.array(z.enum(['entry_args', 'return_value', 'callstack'])).optional()
      .describe('로깅 유형 (기본: entry_args, return_value)')
  },
  async ({ function_name, module_name, log_types }) => {
    if (!fridaSession) {
      return { content: [{ type: 'text', text: 'Error: Frida 세션 없음. frida_attach를 먼저 실행하세요.' }] };
    }

    const hookId = `${module_name || 'global'}:${function_name}`;
    if (installedHooks.has(hookId)) {
      return { content: [{ type: 'text', text: JSON.stringify({
        success: false,
        error: `이미 훅이 설치되어 있습니다: ${hookId}`,
        installed_hooks: Array.from(installedHooks.keys())
      }, null, 2) }] };
    }

    try {
      const types = log_types || ['entry_args', 'return_value'];
      const scriptCode = generateHookScript(module_name || null, function_name, types);
      const script = await fridaSession.createScript(scriptCode);

      let hookResult = null;
      script.message.connect((message) => {
        if (message.type === 'send' && message.payload) {
          if (message.payload.type === 'hook_installed') {
            hookResult = message.payload;
          } else if (message.payload.type === 'hook_event') {
            hookLogs.push(message.payload);
          } else if (message.payload.type === 'error') {
            hookResult = { error: message.payload.message };
          }
        }
      });

      await script.load();

      // 잠시 대기하여 hook_installed 또는 error 메시지 수신
      await new Promise(resolve => setTimeout(resolve, 1000));

      if (hookResult?.error) {
        await script.unload();
        return { content: [{ type: 'text', text: JSON.stringify({
          success: false,
          function_name,
          module_name: module_name || 'global',
          error: hookResult.error
        }, null, 2) }] };
      }

      installedHooks.set(hookId, { script, function_name, module_name, log_types: types });

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        hook_id: hookId,
        function_name,
        module_name: module_name || 'global',
        log_types: types,
        address: hookResult?.address || 'resolved',
        total_hooks: installedHooks.size,
        message: 'frida_get_logs로 수집된 로그를 확인하세요.'
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
 * frida_list_modules — 로드된 모듈 목록
 */
server.tool(
  'frida_list_modules',
  {},
  async () => {
    if (!fridaSession) {
      return { content: [{ type: 'text', text: 'Error: Frida 세션 없음.' }] };
    }

    try {
      let modules = [];
      const script = await fridaSession.createScript(LIST_MODULES_SCRIPT);
      script.message.connect((message) => {
        if (message.type === 'send' && message.payload?.type === 'modules') {
          modules = message.payload.data;
        }
      });
      await script.load();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await script.unload();

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        total_modules: modules.length,
        modules: modules.slice(0, 100)
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
 * frida_list_exports — 특정 모듈의 export 함수 목록
 */
server.tool(
  'frida_list_exports',
  {
    module_name: z.string().describe('모듈 이름 (예: libc.so.6, libssl.so.3)')
  },
  async ({ module_name }) => {
    if (!fridaSession) {
      return { content: [{ type: 'text', text: 'Error: Frida 세션 없음.' }] };
    }

    try {
      let exports = [];
      let totalCount = 0;
      const script = await fridaSession.createScript(listExportsScript(module_name));
      script.message.connect((message) => {
        if (message.type === 'send' && message.payload?.type === 'exports') {
          exports = message.payload.data;
          totalCount = message.payload.count;
        }
      });
      await script.load();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await script.unload();

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        module: module_name,
        total_exports: totalCount,
        exports_returned: exports.length,
        exports
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
 * frida_inject_script — 커스텀 Frida 스크립트 삽입
 */
server.tool(
  'frida_inject_script',
  {
    script_code: z.string().describe('Frida JavaScript 스크립트 코드'),
    timeout: z.number().optional().describe('스크립트 실행 대기 시간 (ms, 기본: 5000)')
  },
  async ({ script_code, timeout }) => {
    if (!fridaSession) {
      return { content: [{ type: 'text', text: 'Error: Frida 세션 없음.' }] };
    }

    try {
      const messages = [];
      const script = await fridaSession.createScript(script_code);
      script.message.connect((message) => {
        if (message.type === 'send') {
          messages.push(message.payload);
        } else if (message.type === 'error') {
          messages.push({ error: message.description, stack: message.stack });
        }
      });

      await script.load();
      await new Promise(resolve => setTimeout(resolve, timeout || 5000));

      return { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        messages_received: messages.length,
        messages: messages.slice(0, 50)
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
 * frida_get_logs — 수집된 훅 로그 조회
 */
server.tool(
  'frida_get_logs',
  {
    function_filter: z.string().optional().describe('함수 이름 필터 (정규식)'),
    event_filter: z.enum(['enter', 'leave', 'all']).optional().describe('이벤트 유형 필터 (기본: all)'),
    limit: z.number().optional().describe('최대 로그 수 (기본: 100)'),
    clear: z.boolean().optional().describe('조회 후 로그 초기화 (기본: false)')
  },
  async ({ function_filter, event_filter, limit, clear }) => {
    let logs = [...hookLogs];

    // 필터 적용
    if (function_filter) {
      const regex = new RegExp(function_filter, 'i');
      logs = logs.filter(l => regex.test(l.function));
    }
    if (event_filter && event_filter !== 'all') {
      logs = logs.filter(l => l.event === event_filter);
    }

    const maxLogs = limit || 100;
    const returnLogs = logs.slice(-maxLogs); // 최신 로그 우선

    // 요약 통계
    const summary = {};
    for (const log of hookLogs) {
      const key = `${log.function}:${log.event}`;
      summary[key] = (summary[key] || 0) + 1;
    }

    const result = {
      success: true,
      total_logs: hookLogs.length,
      filtered_count: logs.length,
      returned_count: returnLogs.length,
      installed_hooks: Array.from(installedHooks.keys()),
      summary: Object.entries(summary).map(([k, v]) => ({ hook: k, count: v })),
      logs: returnLogs
    };

    if (clear) {
      hookLogs = [];
      result.cleared = true;
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

/**
 * frida_unhook — 설치된 훅 제거
 */
server.tool(
  'frida_unhook',
  {
    hook_id: z.string().optional().describe('제거할 훅 ID (module:function). 생략 시 모든 훅 제거'),
    detach: z.boolean().optional().describe('훅 제거 후 세션도 종료 (기본: false)')
  },
  async ({ hook_id, detach }) => {
    if (!fridaSession) {
      return { content: [{ type: 'text', text: 'Error: Frida 세션 없음.' }] };
    }

    const removed = [];

    if (hook_id) {
      const hook = installedHooks.get(hook_id);
      if (hook) {
        try { await hook.script.unload(); } catch (e) { /* ignore */ }
        installedHooks.delete(hook_id);
        removed.push(hook_id);
      }
    } else {
      // 모든 훅 제거
      for (const [id, hook] of installedHooks) {
        try { await hook.script.unload(); } catch (e) { /* ignore */ }
        removed.push(id);
      }
      installedHooks.clear();
    }

    if (detach && fridaSession) {
      try { await fridaSession.detach(); } catch (e) { /* ignore */ }
      fridaSession = null;
    }

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      removed_hooks: removed,
      remaining_hooks: Array.from(installedHooks.keys()),
      session_detached: detach || false,
      total_logs_collected: hookLogs.length
    }, null, 2) }] };
  }
);

// 정리
process.on('SIGINT', async () => {
  for (const [, hook] of installedHooks) {
    try { await hook.script.unload(); } catch (e) { /* ignore */ }
  }
  if (fridaSession) {
    try { await fridaSession.detach(); } catch (e) { /* ignore */ }
  }
  process.exit(0);
});

// Start server
server.run({ transport: 'stdio' }).catch(console.error);
