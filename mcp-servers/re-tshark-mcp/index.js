#!/usr/bin/env node
/**
 * RE Network Analysis MCP Server
 *
 * tshark(Wireshark CLI)를 활용한 네트워크 트래픽 캡처·분석 MCP 도구 서버.
 * 바이너리 실행 중의 네트워크 통신 패턴을 관찰하여 증적을 수집한다.
 *
 * 관찰 중심(Observation-Only): 트래픽을 수정하지 않고 캡처만 수행.
 */
import { McpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

const TSHARK_PATH = process.env.TSHARK_PATH || 'tshark';
const OUTPUT_DIR = process.env.TSHARK_OUTPUT_DIR || join(tmpdir(), 'dokodemodoor-tshark');

if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 활성 캡처 세션
const activeSessions = new Map();

/**
 * [목적] tshark JSON 출력을 실행하고 결과를 반환.
 */
async function runTshark(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(TSHARK_PATH, args, {
      timeout: options.timeout || 60000,
      maxBuffer: 50 * 1024 * 1024,
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

const server = new McpServer({
  name: 're-tshark',
  version: '1.0.0',
  description: 'Network traffic capture and analysis via tshark'
});

/**
 * tshark_start_capture — 네트워크 캡처 시작
 */
server.tool(
  'tshark_start_capture',
  {
    interface_name: z.string().optional().describe('캡처 인터페이스 (예: eth0, any). 생략 시 기본 인터페이스'),
    capture_filter: z.string().optional().describe('BPF 캡처 필터 (예: "host 1.2.3.4", "port 443", "tcp")'),
    process_filter: z.string().optional().describe('특정 프로세스 관련 트래픽만 (PID 기반 — iptables/nftables 필요)'),
    duration: z.number().optional().describe('캡처 시간 (초, 기본: 30)'),
    max_packets: z.number().optional().describe('최대 패킷 수 (기본: 10000)')
  },
  async ({ interface_name, capture_filter, process_filter, duration, max_packets }) => {
    const sessionId = randomUUID().substring(0, 8);
    const pcapFile = join(OUTPUT_DIR, `capture-${sessionId}.pcap`);
    const maxDuration = duration || 30;
    const maxPkts = max_packets || 10000;

    try {
      const tsharkArgs = [];

      // 인터페이스
      if (interface_name) {
        tsharkArgs.push('-i', interface_name);
      }

      // BPF 캡처 필터
      if (capture_filter) {
        tsharkArgs.push('-f', capture_filter);
      }

      // 출력 파일
      tsharkArgs.push('-w', pcapFile);

      // 시간/패킷 제한
      tsharkArgs.push('-a', `duration:${maxDuration}`);
      tsharkArgs.push('-c', String(maxPkts));

      // 조용 모드
      tsharkArgs.push('-q');

      const tsharkProc = spawn(TSHARK_PATH, tsharkArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const timeoutId = setTimeout(() => {
        if (tsharkProc.pid) {
          tsharkProc.kill('SIGINT');
        }
      }, (maxDuration + 5) * 1000);

      activeSessions.set(sessionId, {
        process: tsharkProc,
        timeoutId,
        pcapFile,
        captureFilter: capture_filter || null,
        interfaceName: interface_name || 'default',
        startTime: new Date().toISOString(),
        status: 'capturing'
      });

      tsharkProc.on('exit', (code) => {
        clearTimeout(timeoutId);
        const session = activeSessions.get(sessionId);
        if (session) {
          session.status = 'completed';
          session.exitCode = code;
          session.endTime = new Date().toISOString();
        }
      });

      tsharkProc.on('error', (err) => {
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
        pcap_file: pcapFile,
        interface: interface_name || 'default',
        capture_filter: capture_filter || 'none',
        max_duration: maxDuration,
        max_packets: maxPkts,
        message: `캡처 시작됨. ${maxDuration}초 후 자동 종료. tshark_stop_capture 또는 tshark_analyze_capture로 결과 확인.`,
        hint: '권한 오류 시: sudo setcap cap_net_raw+eip $(which tshark) 또는 sudo로 실행'
      }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({
        success: false,
        error: error.message,
        hint: 'tshark 설치: sudo apt install tshark'
      }, null, 2) }] };
    }
  }
);

/**
 * tshark_stop_capture — 캡처 중지 + PCAP 요약
 */
server.tool(
  'tshark_stop_capture',
  {
    session_id: z.string().describe('캡처 세션 ID')
  },
  async ({ session_id }) => {
    const session = activeSessions.get(session_id);
    if (!session) {
      return { content: [{ type: 'text', text: JSON.stringify({
        error: `세션 ${session_id}을 찾을 수 없습니다.`,
        active_sessions: Array.from(activeSessions.keys())
      }, null, 2) }] };
    }

    if (session.status === 'capturing' && session.process?.pid) {
      try {
        clearTimeout(session.timeoutId);
        session.process.kill('SIGINT');
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (e) { /* ignore */ }
    }

    session.status = 'stopped';
    session.endTime = new Date().toISOString();

    // PCAP 기본 통계
    let stats = {};
    if (existsSync(session.pcapFile)) {
      const result = await runTshark(['-r', session.pcapFile, '-q', '-z', 'io,stat,0'], { timeout: 30000 });
      if (result.success) {
        stats.raw = result.stdout.substring(0, 3000);
      }

      // 패킷 수
      const countResult = await runTshark(['-r', session.pcapFile, '-T', 'fields', '-e', 'frame.number'], { timeout: 15000 });
      if (countResult.success) {
        stats.packet_count = countResult.stdout.trim().split('\n').length;
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      session_id,
      pcap_file: session.pcapFile,
      start_time: session.startTime,
      end_time: session.endTime,
      stats,
      message: 'tshark_analyze_capture로 상세 분석을 수행하세요.'
    }, null, 2) }] };
  }
);

/**
 * tshark_analyze_capture — PCAP 파일 분석 (프로토콜 통계, 엔드포인트)
 */
server.tool(
  'tshark_analyze_capture',
  {
    session_id: z.string().optional().describe('세션 ID (또는 pcap_path 직접 지정)'),
    pcap_path: z.string().optional().describe('PCAP 파일 경로 (session_id 대신)'),
    analysis_type: z.enum(['summary', 'protocols', 'endpoints', 'conversations', 'expert']).optional()
      .describe('분석 유형 (기본: summary)')
  },
  async ({ session_id, pcap_path, analysis_type }) => {
    const pcapFile = pcap_path || activeSessions.get(session_id)?.pcapFile;
    if (!pcapFile || !existsSync(pcapFile)) {
      return { content: [{ type: 'text', text: JSON.stringify({
        error: 'PCAP 파일을 찾을 수 없습니다.',
        session_id,
        pcap_path
      }, null, 2) }] };
    }

    const type = analysis_type || 'summary';
    let result;

    switch (type) {
      case 'summary': {
        // 프로토콜 계층 통계
        const proto = await runTshark(['-r', pcapFile, '-q', '-z', 'io,phs'], { timeout: 30000 });
        // 엔드포인트 요약
        const endpoints = await runTshark(['-r', pcapFile, '-q', '-z', 'endpoints,ip'], { timeout: 30000 });
        result = {
          protocol_hierarchy: proto.stdout?.substring(0, 5000) || proto.error,
          ip_endpoints: endpoints.stdout?.substring(0, 3000) || endpoints.error
        };
        break;
      }
      case 'protocols': {
        const r = await runTshark(['-r', pcapFile, '-q', '-z', 'io,phs'], { timeout: 30000 });
        result = { protocol_hierarchy: r.stdout?.substring(0, 8000) || r.error };
        break;
      }
      case 'endpoints': {
        const ipR = await runTshark(['-r', pcapFile, '-q', '-z', 'endpoints,ip'], { timeout: 30000 });
        const tcpR = await runTshark(['-r', pcapFile, '-q', '-z', 'endpoints,tcp'], { timeout: 30000 });
        result = {
          ip_endpoints: ipR.stdout?.substring(0, 5000) || ipR.error,
          tcp_endpoints: tcpR.stdout?.substring(0, 5000) || tcpR.error
        };
        break;
      }
      case 'conversations': {
        const r = await runTshark(['-r', pcapFile, '-q', '-z', 'conv,tcp'], { timeout: 30000 });
        result = { tcp_conversations: r.stdout?.substring(0, 8000) || r.error };
        break;
      }
      case 'expert': {
        const r = await runTshark(['-r', pcapFile, '-q', '-z', 'expert'], { timeout: 30000 });
        result = { expert_info: r.stdout?.substring(0, 8000) || r.error };
        break;
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      pcap_file: pcapFile,
      analysis_type: type,
      ...result
    }, null, 2) }] };
  }
);

/**
 * tshark_get_http_streams — HTTP 요청/응답 스트림 추출
 */
server.tool(
  'tshark_get_http_streams',
  {
    session_id: z.string().optional().describe('세션 ID'),
    pcap_path: z.string().optional().describe('PCAP 파일 경로'),
    host_filter: z.string().optional().describe('호스트 필터 (정규식)'),
    limit: z.number().optional().describe('최대 스트림 수 (기본: 50)')
  },
  async ({ session_id, pcap_path, host_filter, limit }) => {
    const pcapFile = pcap_path || activeSessions.get(session_id)?.pcapFile;
    if (!pcapFile || !existsSync(pcapFile)) {
      return { content: [{ type: 'text', text: 'Error: PCAP 파일을 찾을 수 없습니다.' }] };
    }

    const maxStreams = limit || 50;

    // HTTP 요청 추출
    const fields = [
      '-e', 'frame.number', '-e', 'frame.time_relative',
      '-e', 'ip.src', '-e', 'ip.dst',
      '-e', 'http.request.method', '-e', 'http.request.uri',
      '-e', 'http.host', '-e', 'http.response.code',
      '-e', 'http.content_type', '-e', 'http.content_length'
    ];

    let displayFilter = 'http.request || http.response';
    if (host_filter) {
      displayFilter = `(http.request || http.response) && http.host matches "${host_filter}"`;
    }

    const result = await runTshark([
      '-r', pcapFile,
      '-Y', displayFilter,
      '-T', 'fields', '-E', 'separator=|', '-E', 'header=y',
      ...fields,
      '-c', String(maxStreams * 2) // 요청+응답 쌍
    ], { timeout: 30000 });

    if (!result.success) {
      // HTTP2/HTTPS는 암호화되어 추출 불가 — 대안 제시
      return { content: [{ type: 'text', text: JSON.stringify({
        success: false,
        error: result.error,
        hint: 'HTTPS 트래픽은 암호화되어 HTTP 스트림 추출이 불가합니다. tshark_get_tls_handshakes로 TLS 정보를 확인하세요.'
      }, null, 2) }] };
    }

    // 필드 기반 파싱
    const lines = result.stdout.trim().split('\n');
    const header = lines[0]?.split('|') || [];
    const streams = lines.slice(1, maxStreams + 1).map(line => {
      const vals = line.split('|');
      const obj = {};
      header.forEach((h, i) => { if (vals[i]) obj[h.trim()] = vals[i].trim(); });
      return obj;
    });

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      pcap_file: pcapFile,
      total_http_packets: lines.length - 1,
      streams_returned: streams.length,
      streams
    }, null, 2) }] };
  }
);

/**
 * tshark_get_dns_queries — DNS 쿼리/응답 추출
 */
server.tool(
  'tshark_get_dns_queries',
  {
    session_id: z.string().optional().describe('세션 ID'),
    pcap_path: z.string().optional().describe('PCAP 파일 경로'),
    domain_filter: z.string().optional().describe('도메인 필터 (정규식)'),
    limit: z.number().optional().describe('최대 결과 수 (기본: 100)')
  },
  async ({ session_id, pcap_path, domain_filter, limit }) => {
    const pcapFile = pcap_path || activeSessions.get(session_id)?.pcapFile;
    if (!pcapFile || !existsSync(pcapFile)) {
      return { content: [{ type: 'text', text: 'Error: PCAP 파일을 찾을 수 없습니다.' }] };
    }

    let displayFilter = 'dns';
    if (domain_filter) {
      displayFilter = `dns && dns.qry.name matches "${domain_filter}"`;
    }

    const result = await runTshark([
      '-r', pcapFile,
      '-Y', displayFilter,
      '-T', 'fields', '-E', 'separator=|', '-E', 'header=y',
      '-e', 'frame.time_relative',
      '-e', 'ip.src', '-e', 'ip.dst',
      '-e', 'dns.qry.name', '-e', 'dns.qry.type',
      '-e', 'dns.a', '-e', 'dns.aaaa',
      '-e', 'dns.flags.response',
      '-c', String(limit || 100)
    ], { timeout: 30000 });

    const lines = (result.stdout || '').trim().split('\n');
    const header = lines[0]?.split('|') || [];
    const queries = lines.slice(1).map(line => {
      const vals = line.split('|');
      const obj = {};
      header.forEach((h, i) => { if (vals[i]) obj[h.trim()] = vals[i].trim(); });
      return obj;
    }).filter(q => q['dns.qry.name']);

    // 고유 도메인 집계
    const domainCounts = {};
    for (const q of queries) {
      const domain = q['dns.qry.name'];
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    }
    const uniqueDomains = Object.entries(domainCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([domain, count]) => ({ domain, count }));

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      pcap_file: pcapFile,
      total_dns_packets: queries.length,
      unique_domains: uniqueDomains.length,
      top_domains: uniqueDomains.slice(0, 30),
      queries: queries.slice(0, limit || 100)
    }, null, 2) }] };
  }
);

/**
 * tshark_get_tls_handshakes — TLS 핸드셰이크 정보 (SNI, 인증서)
 */
server.tool(
  'tshark_get_tls_handshakes',
  {
    session_id: z.string().optional().describe('세션 ID'),
    pcap_path: z.string().optional().describe('PCAP 파일 경로'),
    sni_filter: z.string().optional().describe('SNI(Server Name) 필터 (정규식)'),
    limit: z.number().optional().describe('최대 결과 수 (기본: 50)')
  },
  async ({ session_id, pcap_path, sni_filter, limit }) => {
    const pcapFile = pcap_path || activeSessions.get(session_id)?.pcapFile;
    if (!pcapFile || !existsSync(pcapFile)) {
      return { content: [{ type: 'text', text: 'Error: PCAP 파일을 찾을 수 없습니다.' }] };
    }

    // Client Hello (SNI 포함)
    let displayFilter = 'tls.handshake.type == 1';
    if (sni_filter) {
      displayFilter += ` && tls.handshake.extensions_server_name matches "${sni_filter}"`;
    }

    const clientHellos = await runTshark([
      '-r', pcapFile,
      '-Y', displayFilter,
      '-T', 'fields', '-E', 'separator=|', '-E', 'header=y',
      '-e', 'frame.time_relative',
      '-e', 'ip.src', '-e', 'ip.dst', '-e', 'tcp.dstport',
      '-e', 'tls.handshake.extensions_server_name',
      '-e', 'tls.handshake.version',
      '-e', 'tls.handshake.ciphersuite',
      '-c', String(limit || 50)
    ], { timeout: 30000 });

    const lines = (clientHellos.stdout || '').trim().split('\n');
    const header = lines[0]?.split('|') || [];
    const handshakes = lines.slice(1).map(line => {
      const vals = line.split('|');
      const obj = {};
      header.forEach((h, i) => { if (vals[i]) obj[h.trim()] = vals[i].trim(); });
      return obj;
    }).filter(h => h['ip.dst']);

    // SNI별 집계
    const sniCounts = {};
    for (const h of handshakes) {
      const sni = h['tls.handshake.extensions_server_name'] || '(no SNI)';
      sniCounts[sni] = (sniCounts[sni] || 0) + 1;
    }
    const uniqueSNIs = Object.entries(sniCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([sni, count]) => ({ sni, count }));

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      pcap_file: pcapFile,
      total_tls_handshakes: handshakes.length,
      unique_snis: uniqueSNIs.length,
      top_snis: uniqueSNIs.slice(0, 30),
      handshakes: handshakes.slice(0, limit || 50)
    }, null, 2) }] };
  }
);

// 정리
process.on('SIGINT', () => {
  for (const [, session] of activeSessions) {
    if (session.process?.pid) session.process.kill('SIGINT');
  }
  process.exit(0);
});

server.run({ transport: 'stdio' }).catch(console.error);
