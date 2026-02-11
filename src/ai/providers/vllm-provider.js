/**
* vLLM 제공자 구현
* OpenAI SDK를 사용하여 vLLM 서버와 통신하는 LLM 제공자 인터페이스를 구현합니다.
* 안정성, 도구 별칭 처리 및 강력한 결과물 강제 적용에 최적화되어 있습니다.
*/

import OpenAI from 'openai';
import { LLMProvider } from '../llm-provider.js';
import { toolRegistry } from '../tools/tool-registry.js';
import { executeToolCalls } from '../tools/tool-executor.js';
import { config as dokodemodoorConfig } from '../../config/env.js';
import { runWithContext, getAuditSession } from '../../utils/context.js';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';

/**
* [목적] vLLM 기반의 OpenAI 호환 프로바이더로, 툴콜 강화 기능을 제공합니다.
*
* [호출 경로]
* - src/ai/llm-provider.js::createLLMProvider() 함수는 설정에 따라 프로바이더를 생성합니다.
*
* [출력]
* - 에이전트 실행 파이프라인에서 사용되는 query() 생성기를 노출합니다.
*
* [종속성]
* - openai SDK, toolRegistry/executeToolCalls, 환경 설정, 감사 컨텍스트 유틸리티
*
* [참고]
* - 전달 가능한 유형 매핑 및 프롬프트 압축을 적용하여 드리프트를 방지합니다.
*/
export class VLLMProvider extends LLMProvider {
  /**
  * [목적] 공급자 구성 및 OpenAI 클라이언트를 초기화합니다.
  *
  * [호출되는 곳]
  * - src/ai/llm-provider.js::createLLMProvider()
  *
  * [출력 대상]
  * - query() 및 헬퍼 함수에서 사용하는 인스턴스 필드를 설정합니다.
  *
  * [입력 매개변수]
  * - config (객체): vLLM 연결 + 런타임 설정
  *
  * [부작용]
  * - OpenAI 클라이언트 인스턴스를 생성합니다.
  *
  * [참고]
  * - 로컬 vLLM의 경우 apiKey가 제공되지 않으면 'EMPTY'로 설정됩니다.

  */
  constructor(config) {
    super();
    this.config = config;
    this.client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey || 'EMPTY',
      timeout: 180000 // 3 minutes
    });
    this.model = config.model;
    this.temperature = config.temperature || 0.1;
    this.maxTurns = config.maxTurns || 100;
    this.maxPromptChars = config.maxPromptChars || 32000;
    this.promptTokenPrice = config.promptTokenPrice || 0;
    this.completionTokenPrice = config.completionTokenPrice || 0;
  }

  /**
  * [목적] 로깅/선택을 위한 공급자 이름을 식별합니다.
  *
  * [호출 대상]
  * - LLMProvider 인터페이스 소비자(예: 에이전트 실행기 디버그 출력).
  *
  * [출력 대상]
  * - 공급자 이름 문자열을 반환합니다.
  *
  * [반환 값]
  * - 문자열: 'vllm'.
  */
  getName() { return 'vllm'; }

  /**
   * Calculate cost based on token usage and configured prices.
   */
  calculateCost(usage) {
    if (!usage) return 0;
    const promptCost = (usage.prompt_tokens / 1000000) * this.promptTokenPrice;
    const completionCost = (usage.completion_tokens / 1000000) * this.completionTokenPrice;
    return promptCost + completionCost;
  }

  /**
  * [목적] 런타임에 공급자 기능을 설명합니다.
  *
  * [호출 대상]
  * - 도구/스트림 옵션을 결정할 때 LLMProvider 인터페이스를 사용하는 소비자.
  *
  * [출력 대상]
  * - 실행 동작에 사용되는 기능 객체를 반환합니다.
  *
  * [반환 값]
  * - 객체: 스트리밍/도구 호출/최대 턴 수 등
  */
  getCapabilities() {
    return {
      streaming: true,
      toolCalling: true,
      maxTurns: this.maxTurns,
      autonomousExecution: false,
      mcpServers: false
    };
  }

  /**
  * 체계적인 전달물 유형 강제 적용.
  * 퍼지 키워드 매칭을 사용하여 에이전트가 항상 올바르게 할당된 파일 유형에 저장하도록 합니다.
  *
  * [목적] 에이전트 이름과 요청된 유형을 강제된 전달물 유형에 매핑합니다.
  *
  * [호출 위치]
  * - save_deliverable 도구 호출을 정규화할 때 VLLMProvider.query() 호출.
  *
  * [출력]
  * - 도구 인수를 재정의하는 데 사용되는 전달물 유형 문자열을 반환합니다.
  *
  * [입력 매개변수]
  * - agentName (문자열): 에이전트 식별자(예: sqli-vuln).
  * - requestedType (문자열|null): 모델 출력에서 ​​제안된 전달물 유형.
  *
  * [반환 값]
  * - 문자열: 강제된 전달물 유형.
  *
  * [참고]
  * - 익스플로잇 에이전트는 증거 유형으로 분석/큐 유형을 재정의할 수 있습니다.
  */
  getForcedDeliverableType(agentName, requestedType = null) {
    const name = (agentName || '').toLowerCase();
    const isQueue = requestedType && requestedType.includes('QUEUE');

    // Fuzzy matching for various agent name formats
    let forced = requestedType || (name.includes('recon') ? 'RECON' : 'CODE_ANALYSIS');
    if (name.includes('recon-verify')) forced = 'RECON_VERIFY';
    else if (name.includes('fuzzer') || name.includes('api')) forced = 'API_FUZZ_REPORT';
    else if (name.includes('osv')) forced = isQueue ? 'OSV_QUEUE' : 'OSV_REPORT';
    else if (name.includes('authz')) forced = isQueue ? 'AUTHZ_QUEUE' : 'AUTHZ_ANALYSIS';
    else if (name.includes('auth')) forced = isQueue ? 'AUTH_QUEUE' : 'AUTH_ANALYSIS';
    else if (name.includes('xss')) forced = isQueue ? 'XSS_QUEUE' : 'XSS_ANALYSIS';
    else if (name.includes('ssrf')) forced = isQueue ? 'SSRF_QUEUE' : 'SSRF_ANALYSIS';
    // Injection agents (check specific types before generic 'injection')
    else if (name.includes('sqli')) forced = isQueue ? 'SQLI_QUEUE' : 'SQLI_ANALYSIS';
    else if (name.includes('codei')) forced = isQueue ? 'CODEI_QUEUE' : 'CODEI_ANALYSIS';
    else if (name.includes('ssti')) forced = isQueue ? 'SSTI_QUEUE' : 'SSTI_ANALYSIS';
    else if (name.includes('pathi')) forced = isQueue ? 'PATHI_QUEUE' : 'PATHI_ANALYSIS';
    else if (name.includes('injection')) forced = isQueue ? 'INJECTION_QUEUE' : 'INJECTION_ANALYSIS'; // Legacy fallback
    // IMPORTANT: Check 'pre-recon' BEFORE 'recon' to avoid false matches
    else if (name.includes('pre-recon')) forced = 'CODE_ANALYSIS';
    else if (name.includes('recon')) forced = 'RECON';
    else if (name.includes('report') || name.includes('final')) forced = 'FINAL_REPORT';

    // Exploitation evidence override
    if (name.includes('exploit')) {
      if (name.includes('authz')) forced = 'AUTHZ_EVIDENCE';
      else if (name.includes('auth')) forced = 'AUTH_EVIDENCE';
      else if (name.includes('xss')) forced = 'XSS_EVIDENCE';
      else if (name.includes('ssrf')) forced = 'SSRF_EVIDENCE';
      else if (name.includes('sqli')) forced = 'SQLI_EVIDENCE';
      else if (name.includes('codei')) forced = 'CODEI_EVIDENCE';
      else if (name.includes('ssti')) forced = 'SSTI_EVIDENCE';
      else if (name.includes('pathi')) forced = 'PATHI_EVIDENCE';
      else if (name.includes('injection')) forced = 'INJECTION_EVIDENCE';
    }

    return forced;
  }

  /**
   * Resolve a consistent mission name from agent name.
   */
  /**
   * [목적] 에이전트 이름을 미션 슬러그로 정규화.
   *
   * [호출자]
   * - VLLMProvider.extractFindings()
   * - VLLMProvider.query()
   *
   * [출력 대상]
   * - Returns normalized mission name for filesystem paths and logs.
   *
   * [입력 파라미터]
   * - agentName (string): Agent identifier.
   *
   * [반환값]
   * - string: slugified mission name.
   */
  getMissionName(agentName) {
    if (!agentName) return 'generic';
    const name = (agentName || '').toLowerCase().replace(/^(sub-agent-|taskagent-)/, '');
    const match = name.match(/^(.+)-(vuln|exploit)$/);
    if (match) return match[1];
    return name.replace(/[^a-z0-9]/g, '-');
  }

  /**
   * Resolve mission directory for findings, separating exploit runs when needed.
   */
  getMissionDir(targetDir, missionName, agentName = '') {
    const isExploit = (agentName || '').toLowerCase().includes('exploit');
    const safeMission = isExploit ? `${missionName}-exploit` : missionName;
    return path.join(targetDir, 'deliverables/findings', safeMission);
  }

  /**
   * Get default todo for a specific mission and phase.
   */
  /**
   * [목적] 미션/단계별 기본 todo 체크리스트 제공.
   *
   * [호출자]
   * - VLLMProvider.query() when creating initial todo.txt for agents.
   *
   * [출력 대상]
   * - Returns a newline-separated checklist string.
   *
   * [입력 파라미터]
   * - missionName (string): Normalized mission.
   * - agentName (string): Full agent name (used to infer exploit vs analysis).
   *
   * [반환값]
   * - string: checklist content.
   */
  getMissionTodo(missionName, agentName = '') {
    const isExploit = (agentName || '').toLowerCase().includes('exploit');
    const name = missionName.toLowerCase();

    if (name.includes('ssti')) {
      return isExploit
        ? "[ ] Read ssti_exploitation_queue.json\n[ ] Perform Confirmation & Probing\n[ ] Perform Engine Fingerprinting\n[ ] Perform Impact & Sandbox Escape\n[ ] Save SSTI_EVIDENCE"
        : "[ ] Map Template Engine Renders (pug, ejs, etc.)\n[ ] Trace Untrusted Data to Template Sinks\n[ ] Verify Context (Engine type, API, Escape mode)\n[ ] Check Sanitization & Sandboxing\n[ ] Use Playwright to verify rendering behavior if needed\n[ ] Document SSTI Findings (Analysis + Queue)";
    }
    if (name.includes('xss')) {
      return isExploit
        ? "[ ] Read xss_exploitation_queue.json\n[ ] Perform Confirmation & Probing\n[ ] Perform Impact Verification\n[ ] Save XSS_EVIDENCE"
        : "[ ] Map Sink Points for Stored XSS\n[ ] Identify Reflective XSS Vectors\n[ ] Use Playwright to verify XSS execution and CSP bypass\n[ ] Check for DOMPurify or custom sanitizers\n[ ] Document XSS Findings (Analysis + Queue)";
    }
    if (name.includes('path')) {
      return isExploit
        ? "[ ] Read pathi_exploitation_queue.json\n[ ] Perform Confirmation & Probing\n[ ] Perform Environment Probing & Bypass\n[ ] Perform Information Exfiltration\n[ ] Save PATHI_EVIDENCE"
        : "[ ] Map File System Sinks (fs.readFile, etc.)\n[ ] Identify Untrusted Input to Path Params\n[ ] Check for Path Normalization/Bypass\n[ ] Verify exploitability via Playwright if network-accessible\n[ ] Document Path Injection Findings (Analysis + Queue)";
    }
    if (name.includes('sqli')) {
      return isExploit
        ? "[ ] Read sqli_exploitation_queue.json\n[ ] Perform Confirmation & Probing\n[ ] Perform Fingerprinting & Enumeration\n[ ] Perform Targeted Exfiltration\n[ ] Save SQLI_EVIDENCE"
        : "[ ] Map SQL Injection Sinks\n[ ] Trace Untrusted Data to Query Fragments\n[ ] Analyze Sanitization (bind, cast, whitelist)\n[ ] Check Concatenations & Formatting\n[ ] Document SQLi Findings (Analysis + Queue)";
    }
    if (name.includes('codei')) {
      return isExploit
        ? "[ ] Read codei_exploitation_queue.json\n[ ] Perform Confirmation & Probing\n[ ] Perform Probing & Context Discovery\n[ ] Perform Impact Execution\n[ ] Save CODEI_EVIDENCE"
        : "[ ] Map Command/Code Injection Sinks (exec, eval)\n[ ] Trace Untrusted Data to Execution Sinks\n[ ] Verify Argument Escaping/Allowlists\n[ ] Verify remote execution via Playwright if applicable\n[ ] Document Code Injection Findings (Analysis + Queue)";
    }
    if (name.includes('ssrf')) {
      return isExploit
        ? "[ ] Read ssrf_exploitation_queue.json\n[ ] Perform Confirmation & Probing\n[ ] Test Internal Network Access\n[ ] Save SSRF_EVIDENCE"
        : "[ ] Map External Request Sources (fetch, axios, etc.)\n[ ] Analyze URL Parsing and Validation Logic\n[ ] Use Playwright to trigger and verify SSRF callbacks\n[ ] Verify Protocol/Host Allowlists\n[ ] Document SSRF Findings (Analysis + Queue)";
    }
    if (name.includes('authz')) {
      return isExploit
        ? "[ ] Read authz_exploitation_queue.json\n[ ] Perform Confirmation & Probing\n[ ] Perform Vertical/Horizontal Escalation\n[ ] Save AUTHZ_EVIDENCE"
        : "[ ] Analyze Horizontal Privilege Escalation (BOLA)\n[ ] Analyze Vertical Privilege Escalation (RBAC)\n[ ] Check Multi-tenant Isolation Boundaries\n[ ] Use Playwright to verify cross-user data access\n[ ] Document Authorization Flaws (Analysis + Queue)";
    }
    if (name.includes('auth-') || name === 'auth') {
      return isExploit
        ? "[ ] Read auth_exploitation_queue.json\n[ ] Perform Confirmation & Probing\n[ ] Perform Credential Brute-force/Bypass\n[ ] Save AUTH_EVIDENCE"
        : "[ ] Map Authentication Mechanisms and Flow\n[ ] Analyze Session Management and persistence\n[ ] Test for Credential Brute-force Protections\n[ ] Check MFA/2FA Implementation Flaws\n[ ] Use Playwright to test for session fixation/brute-force\n[ ] Document Authentication Vulnerabilities (Analysis + Queue)";
    }
    if (name.includes('recon')) {
      return "[ ] Route & Endpoint Mapper\n[ ] Authentication & Session Flow Tracer\n[ ] Authorization & Ownership Architecture Mapper\n[ ] Input Vector & Validation Analyzer\n[ ] Injection Source Tracer (non-exploit)\n[ ] Workflow & State Machine Analyzer\n[ ] Use Playwright to discover client-side routes and hidden UI\n[ ] Final Synthesis & Report";
    }
    if (name.includes('pre-recon')) {
      return "[ ] Architecture Scanner (stack, deploy model, services, configs)\n[ ] Entry Point Mapper (routes, controllers, uploads, webhooks)\n[ ] Security Pattern Hunter (auth flows, tokens, RBAC/ABAC)\n[ ] Injection & Sink Hunter (SQL, template, command, path, XSS)\n[ ] SSRF / Outbound Request Tracer\n[ ] Data Security Auditor\n[ ] Synthesis & Report Generation";
    }
    if (name.includes('fuzzer') || name.includes('api')) {
      return "[ ] Identify API Endpoints & Methods\n[ ] Map Parameters & Request Schemas\n[ ] Execute Fuzzing Payloads (Anomalies, Error Handling)\n[ ] Analyze Response Patterns & Security Headers\n[ ] Document API Fuzzing Findings & Candidates\n[ ] Update Master Reconnaissance Map";
    }
    if (name.includes('login')) {
      return "[ ] Verify Login Flow using instructions\n[ ] Check Authentication Success & Session Persistence";
    }
    if (name.includes('verify')) {
      return "[ ] Verify Recon Map & Identified Endpoints\n[ ] SQLi Investigation\n[ ] Codei Investigation\n[ ] SSTI Investigation\n[ ] Pathi Investigation\n[ ] XSS Investigation\n[ ] Auth Investigation\n[ ] Authz/IDOR Investigation\n[ ] SSRF Investigation\n[ ] Discover & Add newly found vulnerabilities not in Recon Map";
    }
    return "[ ] Initial Analysis\n[ ] Investigation\n[ ] Documentation";
  }

  /**
   * Extract technical findings from message history for nudges and compression.
   */
  /**
   * [목적] 대화 기록과 저장된 산출물에서 요약 정보 생성.
   *
   * [호출자]
   * - VLLMProvider.query() (nudges/tool enforcement).
   * - VLLMProvider.compressHistory() (compact context).
   *
   * [출력 대상]
   * - Returns a findings object used to guide prompt injection and compression.
   *
   * [입력 파라미터]
   * - messages (array): Chat history messages.
   * - agentName (string): Agent identifier.
   * - targetDir (string): Repo root for deliverables/findings.
   *
   * [반환값]
   * - object: { techStack, endpoints, authInfo, vulnerabilities, lastTodo, doneTasks, stagedFiles }.
   *
   * [부작용]
   * - Reads from filesystem under deliverables/findings when available.
   *
   * [의존성]
   * - node:fs/path, getMissionName().
   *
   * [에러 처리]
   * - Swallows IO errors to keep provider robust.
   */
  extractFindings(messages, agentName = 'generic', targetDir = '.') {
    const findings = { techStack: [], endpoints: [], authInfo: [], vulnerabilities: [], lastTodo: '', doneTasks: new Set(), stagedFiles: [] };
    const missionName = this.getMissionName(agentName);

    // 1. Initial Load from Disk (Persistence)
    if (targetDir && targetDir !== '.') {
      const missionDir = this.getMissionDir(targetDir, missionName, agentName);
      try {
        if (fs.existsSync(missionDir)) {
          const files = fs.readdirSync(missionDir);
          // Broaden filter to include all agent-generated deliverables and evidence
          findings.stagedFiles = files.filter(f =>
            (f.startsWith('staged_') || f.startsWith('finding_') || f.startsWith('findings_')) && f.endsWith('.md')
          );

          const todoPath = path.join(missionDir, 'todo.txt');
          if (fs.existsSync(todoPath)) {
            findings.lastTodo = fs.readFileSync(todoPath, 'utf8');
            findings.lastTodo.split('\n').forEach(l => {
              if (l.includes('[✓]') || l.includes('[x]')) {
                const task = l.replace(/\[[✓x]\]/, '').trim().toLowerCase();
                if (task) findings.doneTasks.add(task);
              }
            });
          }
        }
      } catch (e) {}
    }

    // 2. Parse History for Context (In-Turn Memory)
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.content) {
        try {
          const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
          const output = (content.result || content.output || '').toString();

          const isFinished = content.status === 'complete' || content.status === 'success' || content.status === 'done' || content.status === 'finished' || content.isComplete;
          if (msg.name === 'TaskAgent' && isFinished) {
             // Extract target task from the original tool call
             const call = messages.find(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.some(tc => tc.id === msg.tool_call_id));
             if (call) {
               const toolCall = call.tool_calls.find(tc => tc.id === msg.tool_call_id);
               try {
                 const callArgs = typeof toolCall.function.arguments === 'string' ? JSON.parse(toolCall.function.arguments) : toolCall.function.arguments;
                 if (callArgs.task || callArgs.input) findings.doneTasks.add((callArgs.task || callArgs.input).toLowerCase());
               } catch(e) {}
             }
          }

          if (output.includes('package.json') || output.includes('pom.xml')) findings.techStack.push(output.substring(0, 500));
          if (output.includes('app.get') || output.includes('app.post')) findings.endpoints.push(output.substring(0, 500));
          if (output.includes('jwt') || output.includes('token') || output.includes('secret')) findings.authInfo.push(output.substring(0, 500));

          const isTaskAgent = msg.name === 'TaskAgent';
          const hasVuln = /vulnerability|bypass|auth|leak|exploit/i.test(output);
          if (isTaskAgent || hasVuln) findings.vulnerabilities.push(`- ${output.substring(0, 1000)}`);

          if (msg.name === 'TodoWrite') {
            try {
              const callM = messages.find(m => m.tool_calls && m.tool_calls.some(tc => tc.id === msg.tool_call_id));
              if (callM) {
                const args = JSON.parse(callM.tool_calls.find(tc => tc.id === msg.tool_call_id).function.arguments);
                findings.lastTodo = args.todo;
              }
            } catch (e) {
              if (content.message && content.message.includes('Todo Updated:')) {
                findings.lastTodo = content.message.replace('Todo Updated:', '').trim();
              }
            }
          }
        } catch (e) {}
      }
    }

    return findings;
  }

  /**
   * Enhanced JSON parsing with intelligent fallbacks and hallucination defense.
   */
  /**
   * [목적] 도구 호출 JSON을 완화된 정제/진단과 함께 파싱.
   *
   * [호출자]
   * - VLLMProvider.query() when decoding tool call arguments.
   *
   * [출력 대상]
   * - Returns parsed object with optional __toolName hint.
   *
   * [입력 파라미터]
   * - str (string): JSON string candidate.
   * - toolName (string|null): Expected tool name for better error messaging.
   * - agentName (string|null): Agent identifier for logs.
   *
   * [반환값]
   * - object: parsed JSON object (possibly decorated).
   *
   * [에러 처리]
   * - Throws on unrecoverable parse errors after sanitization.
   *
   * [주의사항]
   * - Attempts to repair trailing commas and tool-name prefixes.
   */
  safeJSONParse(str, toolName = null, agentName = null) {
    if (!str || typeof str !== 'string') return {};
    let trimmed = str.trim();

    const sanitizeJSON = (s) => {
      return s.replace(/"(?:[^"\\]|\\.)*"/g, (match) => {
        return match.replace(/[\x00-\x1F]/g, (c) => {
          if (c === '\n') return '\\n';
          if (c === '\r') return '\\r';
          if (c === '\t') return '\\t';
          return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
        });
      });
    };

    trimmed = sanitizeJSON(trimmed);

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.function && parsed.arguments && typeof parsed.arguments === 'object') {
        return { ...parsed.arguments, __toolName: parsed.function };
      }
      if (parsed.name && parsed.arguments && typeof parsed.arguments === 'object') {
        return { ...parsed.arguments, __toolName: parsed.name };
      }
      return parsed;
    } catch (e) {
      const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.function && parsed.arguments && typeof parsed.arguments === 'object') {
            return { ...parsed.arguments, __toolName: parsed.function };
          }
          return parsed;
        } catch (innerE) {}
      }

      const simpleTools = ['bash', 'execute_command', 'TodoWrite', 'Todo'];
      if (simpleTools.includes(toolName)) {
        if (['bash', 'execute_command'].includes(toolName)) return { command: trimmed };
        if (['TodoWrite', 'Todo'].includes(toolName)) return { todo: trimmed };
      }

      throw new Error(`JSON parsing failed for ${toolName || 'tool'}. Ensure you use valid JSON arguments: ${e.message}`);
    }
  }

  /**
   * Final validation of message history before sending to API.
   */
  /**
   * [목적] API 전송용 메시지(역할/툴콜) 정규화.
   *
   * [호출자]
   * - VLLMProvider.query() before sending prompts to vLLM.
   *
   * [출력 대상]
   * - Returns a sanitized messages array.
   *
   * [입력 파라미터]
   * - messages (array): Raw message history.
   *
   * [반환값]
   * - array: prepared messages.
   */
  prepareMessages(messages) {
    const sanitizeText = (text) => {
      if (!text || typeof text !== 'string') return text;
      return text
        .replace(/\\x/g, '[x]').replace(/\\u/g, '[u]')
        .replace(/<\|[\s\S]*?\|>/g, '') // Sanitize special control tokens
        .replace(/to=functions\.[\w]+/g, '') // Sanitize Llama 3 tool-use leakage
        .replace(/to=call:[\w]+/g, '')
        .replace(/<\|/g, '&lt;|').replace(/\|>/g, '|&gt;')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
    };

    const intermediate = [];
    const activeToolCalls = new Set();

    for (const m of messages) {
      const role = m.role;
      const content = (m.content || '').trim();
      const hasToolCalls = m.tool_calls && m.tool_calls.length > 0;

      if (role === 'assistant' && !content && !hasToolCalls) continue;
      if (role === 'assistant' && !content && hasToolCalls) {
        m.content = ' ';
      }

      if (role === 'assistant' && hasToolCalls) {
        m.tool_calls.forEach(tc => activeToolCalls.add(tc.id));
      }

      if (role === 'tool') {
        if (!activeToolCalls.has(m.tool_call_id)) continue;
        activeToolCalls.delete(m.tool_call_id);
      }

      if (m.content && typeof m.content === 'string') {
        m.content = sanitizeText(m.content);
      }

      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        m.tool_calls = m.tool_calls.map(tc => {
          if (tc?.function?.arguments && typeof tc.function.arguments === 'string') {
            return {
              ...tc,
              function: {
                ...tc.function,
                arguments: sanitizeText(tc.function.arguments)
              }
            };
          }
          return tc;
        });
      }

      intermediate.push({ ...m });
    }

    const cleaned = [];
    for (const m of intermediate) {
      const last = cleaned[cleaned.length - 1];
      if (last && last.role === m.role && !last.tool_calls && !m.tool_calls && last.role !== 'tool') {
        last.content = (last.content + '\n\n' + m.content).trim();
      } else {
        cleaned.push(m);
      }
    }

    while (cleaned.length > 0 && cleaned[cleaned.length - 1].role === 'assistant' && cleaned[cleaned.length - 1].tool_calls) {
        const last = cleaned[cleaned.length - 1];
        if (last.tool_calls.length > 0) cleaned.pop();
        else break;
    }

    // [STRICT WHITELIST] Only allow valid OpenAI API fields to prevent vLLM errors
    // This prevents "unexpected tokens remaining in message header" errors from extra fields
    const whitelisted = cleaned.map(m => {
      const safe = { role: m.role };

      // Only include content if it exists and is non-empty
      if (m.content && typeof m.content === 'string' && m.content.trim()) {
        safe.content = m.content;
      }

      // Include tool-related fields only when present
      if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        safe.tool_calls = m.tool_calls;
      }

      if (m.tool_call_id) {
        safe.tool_call_id = m.tool_call_id;
      }

      if (m.name) {
        safe.name = m.name;
      }

      return safe;
    });

    return whitelisted;
  }

  /**
   * [목적] 프롬프트 대략 크기(문자 수) 계산.
   *
   * [호출자]
   * - VLLMProvider.query() when logging prompt sizes.
   * - VLLMProvider.shrinkMessagesToFitLimit().
   *
   * [출력 대상]
   * - Returns integer char count.
   *
   * [입력 파라미터]
   * - messages (array): Prepared messages.
   *
   * [반환값]
   * - number: total characters.
   */
  getMessagesSize(messages) {
    try {
      return JSON.stringify(messages).length;
    } catch (e) {
      return 0;
    }
  }

  /**
   * [목적] 단일 메시지 내용을 길이 제한에 맞게 절단.
   *
   * [호출자]
   * - VLLMProvider.shrinkMessagesToFitLimit().
   *
   * [출력 대상]
   * - Returns a new message object with truncated content.
   *
   * [입력 파라미터]
   * - message (object): Chat message.
   * - limit (number): Max characters.
   *
   * [반환값]
   * - object: truncated message.
   */
  truncateMessageContent(message, limit) {
    if (!message || !message.content || typeof message.content !== 'string') return message;
    if (message.content.length <= limit) return message;
    return { ...message, content: `${message.content.slice(0, limit)}\n...[truncated]` };
  }

  /**
   * [목적] 도구 호출과 결과 메시지의 짝을 보장.
   *
   * [호출자]
   * - VLLMProvider.shrinkMessagesToFitLimit().
   *
   * [출력 대상]
   * - Returns filtered message list with valid tool call/result pairing.
   *
   * [입력 파라미터]
   * - messages (array): Candidate message list.
   *
   * [반환값]
   * - array: sanitized message list.
   */
  enforceToolCallPairing(messages) {
    const activeToolCalls = new Set();
    const filtered = [];

    for (const m of messages) {
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        m.tool_calls.forEach(tc => activeToolCalls.add(tc.id));
        filtered.push(m);
        continue;
      }
      if (m.role === 'tool') {
        if (!activeToolCalls.has(m.tool_call_id)) continue;
        activeToolCalls.delete(m.tool_call_id);
        filtered.push(m);
        continue;
      }
      filtered.push(m);
    }

    return filtered;
  }

  /**
   * [목적] 툴콜을 깨지 않으면서 히스토리를 크기 제한에 맞게 축소.
   *
   * [호출자]
   * - VLLMProvider.query().
   *
   * [출력 대상]
   * - Returns a size-limited messages array.
   *
   * [입력 파라미터]
   * - messages (array): Prepared messages.
   * - maxChars (number): Size budget.
   *
   * [반환값]
   * - array: trimmed messages.
   *
   * [흐름]
   * - Keep system prompt + recent window.
   * - Truncate per-message content and enforce tool call pairing.
   */
  shrinkMessagesToFitLimit(messages, maxChars, agentName = 'generic') {
    if (!maxChars || !Number.isFinite(maxChars)) return messages;
    const totalSize = (msgs) => JSON.stringify(msgs).length;

    if (totalSize(messages) <= maxChars) return messages;

    console.log(chalk.yellow(`    ⚠️  Prompt size ${totalSize(messages)} chars exceeds ${maxChars}. Trimming...`));

    const isExploit = (agentName || '').toLowerCase().includes('exploit');
    const compressionWindow = isExploit ? 30 : (dokodemodoorConfig.dokodemodoor.contextCompressionWindow || 15);
    let window = Math.min(compressionWindow, Math.max(3, messages.length - 1));
    const minWindow = 3;
    const initial = messages[0];

    let perMessageLimit = Math.max(500, Math.floor(maxChars / Math.max(1, window)));
    let trimmed = [initial, ...messages.slice(-window).map(m => this.truncateMessageContent(m, perMessageLimit))];
    trimmed = this.enforceToolCallPairing(trimmed);

    while (totalSize(trimmed) > maxChars && window > minWindow) {
      window = Math.max(minWindow, window - 2);
      perMessageLimit = Math.max(500, Math.floor(maxChars / Math.max(1, window)));
      trimmed = [initial, ...messages.slice(-window).map(m => this.truncateMessageContent(m, perMessageLimit))];
      trimmed = this.enforceToolCallPairing(trimmed);
    }

    while (totalSize(trimmed) > maxChars && perMessageLimit > 300) {
      perMessageLimit = Math.max(300, Math.floor(perMessageLimit * 0.6));
      trimmed = trimmed.map(m => this.truncateMessageContent(m, perMessageLimit));
      trimmed = this.enforceToolCallPairing(trimmed);
    }

    if (totalSize(trimmed) > maxChars) {
      trimmed = [initial, ...messages.slice(-2).map(m => this.truncateMessageContent(m, 300))];
      trimmed = this.enforceToolCallPairing(trimmed);
    }

    return trimmed;
  }

  /**
   * [목적] 툴콜 처리/스트리밍을 포함한 LLM 메인 루프 실행.
   *
   * [호출자]
   * - src/ai/agent-executor.js::runAgentPromptWithRetry() via provider.query().
   *
   * [출력 대상]
   * - Yields assistant/tool messages to the agent executor.
   * - Executes tools via toolRegistry/executeToolCalls.
   *
   * [입력 파라미터]
   * - prompt (string): Full prompt text.
   * - options (object): { maxTurns, agentName, targetDir, sessionId, ... }.
   *
   * [반환값]
   * - Async generator yielding { type, message } objects.
   *
   * [부작용]
   * - Reads/writes todo.txt and findings files.
   * - Logs prompt sizes and events to audit session.
   * - Calls external vLLM API.
   *
   * [의존성]
   * - OpenAI SDK, toolRegistry, executeToolCalls, context utils.
   *
   * [흐름]
   * - Initialize message history and inject system constraints.
   * - Loop through turns, detect loops, compress history.
   * - Call vLLM API, parse tool calls, execute tools, append results.
   *
   * [에러 처리]
   * - Retries tool-call JSON parsing errors by disabling tools for one attempt.
   */
  async *query(prompt, options = {}) {
    const agentName = options.agentName || 'generic';
    if (!options.cwd) {
      throw new Error('Target directory is required for vLLM provider execution.');
    }
    const targetDir = path.resolve(options.cwd);
    const registry = options.registry || toolRegistry;

    let messages = options.messages || [{ role: 'user', content: prompt }];
    const missionName = this.getMissionName(agentName);

    // [RESUME LOGIC] If this is the start of a Specialist agent, inject previous findings from disk.
    const isSpecialist = /vuln|exploit|recon|pre-recon/i.test(agentName);
    if (isSpecialist && messages.length === 1 && messages[0].role === 'user') {
      const findings = this.extractFindings([], agentName, targetDir);

      if (findings.stagedFiles.length > 0 || findings.lastTodo) {
        console.log(chalk.bold.blue(`    🧠 [RESUME] Agent '${agentName}' detected previous data.`));

        let resumeContext = `## 🔄 RESUMING ANALYSIS SESSION (MEMORY FROM DISK)\n\n`;
        resumeContext += `You are resuming a previous analysis. The following state has been recovered from disk:\n\n`;

        if (findings.lastTodo) {
          resumeContext += `### 📝 CURRENT TODO LIST\n${findings.lastTodo}\n\n`;
        }

        if (findings.stagedFiles.length > 0) {
          resumeContext += `### 📂 COMPLETED ANALYSIS FILES\n`;
          findings.stagedFiles.forEach(f => {
            resumeContext += `- ✅ ${f.replace('.md', '')}\n`;
          });
          resumeContext += `\n`;
        }

        resumeContext += `**INSTRUCTION:** Prioritize the pending items '[ ]' in your Todo list. Use \`TodoWrite\` to update the list as you progress.\n`;
        messages[0].content = `${messages[0].content}\n\n${resumeContext}`;
      }
    }

    let turnCount = 0;
    let nudgeCount = 0;
    let finished = false;
    let savedTypes = new Set();
    const maxTurns = options.maxTurns || this.maxTurns;
    let allowGraceTurns = true; // Enabled by default to provide a safety buffer at the turn limit
    const startTime = Date.now();
    let cumulativeUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    // Semantic Loop Tracking
    let toolUsageHistory = [];

    yield { type: 'system', subtype: 'init', model: this.model, permissionMode: 'bypassPermissions', mcp_servers: [] };

    while (turnCount < (allowGraceTurns ? maxTurns + 5 : maxTurns)) {
      turnCount++;

      if (global.DOKODEMODOOR_DISABLE_LOADER) {
        const name = (agentName || '').toLowerCase();
        let turnColor = (name.includes('sub-agent') || name.includes('taskagent')) ? chalk.magenta : chalk.blue;
        const parentTurnCount = options.parentTurnCount || null;
        const turnDisplay = (name.includes('sub-agent') || name.includes('taskagent')) && parentTurnCount
          ? `Turn ${parentTurnCount}-${turnCount}`
          : `Turn ${turnCount}`;
        console.log(turnColor(`\n    🤖 ${turnDisplay} (${agentName || 'Agent'}):`));

        if (turnCount === 1) {
          try {
            const missionDir = this.getMissionDir(targetDir, missionName, agentName);
            if (!fs.existsSync(missionDir)) fs.mkdirSync(missionDir, { recursive: true });
            const todoPath = path.join(missionDir, 'todo.txt');

            if (!fs.existsSync(todoPath)) {
              const defaultTodo = this.getMissionTodo(missionName, agentName);
              if (defaultTodo) {
                fs.writeFileSync(todoPath, defaultTodo);
                console.log(chalk.bold.blue(`    📝 Auto-injected baseline todo.txt for: ${missionName}`));
              }
            }
          } catch (e) {}
        }
      }

      const name = (agentName || '').toLowerCase();
      const isSubAgent = name.startsWith('sub-agent-') || name.startsWith('taskagent');

      if (!isSubAgent) {
        if (turnCount === maxTurns - 1) {
          let deliverableHint = 'both a technical summary and call save_deliverable twice (Analysis + Queue) before finishing.';
          if (name.includes('recon-verify')) deliverableHint = 'a technical RECON_VERIFY report using save_deliverable.';
          else if (name.includes('recon') && !name.includes('pre-recon')) deliverableHint = 'a technical RECON report using save_deliverable.';
          else if (name.includes('pre-recon')) deliverableHint = 'a technical CODE_ANALYSIS report using save_deliverable.';
          else if (name.includes('fuzzer') || name.includes('api')) deliverableHint = 'a technical API_FUZZ_REPORT using save_deliverable.';
          else if (name.includes('osv-analysis')) deliverableHint = 'both a technical OSV_REPORT and a JSON OSV_QUEUE using save_deliverable twice.';

          // Critical: Force deliverable on last turn
          messages.push({ role: 'system', content: `[FINAL TURN] CRITICAL: You MUST call save_deliverable for ${deliverableHint} NOW. Do not start any new searches or code audits. Use existing information.` });
        } else if (turnCount === Math.floor(maxTurns * 0.95)) {
          messages.push({ role: 'system', content: `[EMERGENCY FINALIZATION] Turn ${turnCount}/${maxTurns}. You are almost out of turns. STOP all discovery immediately. Compile your findings and save your deliverables in the next 2-3 turns.` });
        } else if (turnCount === Math.floor(maxTurns * 0.9)) {
          messages.push({ role: 'system', content: `[WARNING] ${turnCount}/${maxTurns} turns used. You have enough info. Close all open investigations and prepare your deliverables now.` });
        } else if (turnCount === Math.floor(maxTurns * 0.5)) {
          messages.push({ role: 'system', content: `[PROGRESS NUDGE] 50% turns used. If you have found ANY vulnerabilities, call 'save_deliverable' now as a draft. You can update it later.` });
        }
      }

      // [OPERATIONAL GUIDELINE] Inject session-wide constraints
      if (turnCount === 1) {
        messages.push({ role: 'system', content: `[OPERATIONAL GUIDELINE] Never assume a file exists. If a path fails to open, run 'ls' or 'find' to discover the correct path. Do not repeat failed commands.` });
        const name = (agentName || '').toLowerCase();
        if (name.includes('authz')) {
          messages.push({ role: 'system', content: `[SCOPE FOCUS] You are an AUTHORIZATION expert. Focus ONLY on BOLA, IDOR, and Privilege Escalation. Ignore SSRF, XSS, and SQLi.` });
        }
      }

      messages = this.compressHistory(messages, agentName, targetDir);

      // [LOOP DETECTION] Detect A->B->A oscillation patterns
      const assistantMessages = messages.filter(m => m.role === 'assistant');
      if (assistantMessages.length >= 2) {
        const last = assistantMessages[assistantMessages.length - 1];
        const prev = assistantMessages[assistantMessages.length - 2];
        const prevPrev = assistantMessages.length >= 3 ? assistantMessages[assistantMessages.length - 3] : null;

        const getTools = (m) => (m.tool_calls || []).map(tc => tc.function.name);
        const getFullTools = (m) => JSON.stringify((m.tool_calls || []).map(tc => ({
          name: tc.function.name,
          args: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments)
        })));

        const namesLast = getTools(last);
        const namesPrev = getTools(prev);
        const tLast = getFullTools(last);
        const tPrev = getFullTools(prev);
        const tPrevPrev = prevPrev ? getFullTools(prevPrev) : null;

        let repeat = (tLast === tPrev && tLast !== '[]');
        if (!repeat && prevPrev) repeat = (tLast === tPrevPrev && tLast !== '[]');

        // Semantic Loop: Repeated search/open/read without progress
        const recentTools = assistantMessages.slice(-12).flatMap(m => (m.tool_calls || []).map(tc => tc.function.name));
        const searchOpenCount = recentTools.filter(n => ['search_file', 'open_file', 'grep', 'bash', 'read_file'].includes(n)).length;

        // Report Agent specific loop prevention: Don't let it cat the same file forever
        let reportStuck = false;
        if (name.includes('report') && assistantMessages.length > 15) {
          const lastCats = assistantMessages.slice(-10).flatMap(m => (m.tool_calls || [])
            .filter(tc => tc.function.name === 'bash' && (tc.function.arguments.includes('cat') || tc.function.arguments.includes('grep')))
            .map(tc => tc.function.arguments)
          );
          // If the last 4 cats/greps are exactly the same as 4 cats/greps before them, it's stuck
          if (lastCats.length >= 8) {
             const half = Math.floor(lastCats.length / 2);
             if (JSON.stringify(lastCats.slice(0, half)) === JSON.stringify(lastCats.slice(half))) reportStuck = true;
          }
        }

        // Deep Analysis Agents (pre-recon, vuln) need more breathing room for searches
        const isDeepRecon = name.includes('pre-recon') || name.includes('vuln');
        const searchOpenThreshold = isDeepRecon ? 25 : 10;

        if (repeat || searchOpenCount >= searchOpenThreshold || reportStuck) {
           const reason = repeat ? 'repeating tool calls' : (reportStuck ? 'cycling through deliverables' : 'performing extensive internal searches');

           // Forceful nudge: stop doing the loop action
           const isSub = (agentName || description || '').toLowerCase().includes('sub-agent') || (agentName || description || '').toLowerCase().includes('taskagent');

           let nudge = `[LOOP DETECTION] You are ${reason}. You have already tried this or read these files. PLEASE STOP and move to the next item or ${isSub ? 'provide ## Summary' : 'FINAL REPORT'}.`;

           if (isDeepRecon && !repeat && !reportStuck) {
             nudge = `[ANALYSIS NUDGE] You have performed many searches (${searchOpenCount}). Please ensure you are finding NEW information and not cycling. If you have enough info, proceed to synthesis. If not, continue carefully.`;
           }

           if (turnCount > maxTurns * 0.7) {
             nudge = `[LOOP DETECTION] You are ${reason} while turns are low (${turnCount}/${maxTurns}). ABANDON this investigation. Compile what you have and ${isSub ? 'provide ## Summary' : 'SAVE DELIVERABLES'} immediately.`;
           }

           const lastMsg = messages[messages.length - 1];
           if (lastMsg.content !== nudge) {
             console.log(chalk.yellow(`    ⚠️ Loop/Stagnation detected (${reason}). Nudging agent...`));
             messages.push({ role: 'user', content: nudge });
           }
        }
      }

      const shouldLogPromptSize = dokodemodoorConfig.dokodemodoor.debug || dokodemodoorConfig.dokodemodoor.logPromptSizes;
      const buildReadyMessages = async (extraSystemMsg = null) => {
        const baseMessages = extraSystemMsg
          ? [...messages, { role: 'system', content: extraSystemMsg }]
          : messages;
        let readyMessages = this.prepareMessages(baseMessages);
        const preSize = this.getMessagesSize(readyMessages);
        if (shouldLogPromptSize) {
          console.log(chalk.gray(`    🧮 Prompt size (pre-trim): ${preSize} chars, messages=${readyMessages.length}`));
          const auditSession = getAuditSession();
          if (auditSession) {
            await auditSession.logEvent('prompt_size', {
              phase: 'pre-trim',
              size_chars: preSize,
              messages: readyMessages.length,
              timestamp: new Date().toISOString()
            });
          }
        }
        readyMessages = this.shrinkMessagesToFitLimit(readyMessages, this.maxPromptChars, agentName);
        if (shouldLogPromptSize) {
          const postSize = this.getMessagesSize(readyMessages);
          console.log(chalk.gray(`    🧮 Prompt size (post-trim): ${postSize} chars, messages=${readyMessages.length}`));
          const auditSession = getAuditSession();
          if (auditSession) {
            await auditSession.logEvent('prompt_size', {
              phase: 'post-trim',
              size_chars: postSize,
              messages: readyMessages.length,
              timestamp: new Date().toISOString()
            });
          }
        }
        return readyMessages;
      };

      let response = null;
      let toolChoice = 'auto';
      let extraSystemMsg = null;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const readyMessages = await buildReadyMessages(extraSystemMsg);
            response = await this.client.chat.completions.create({
              model: this.model,
              messages: readyMessages,
              tools: registry.getOpenAITools(),
              tool_choice: toolChoice,
              temperature: this.temperature,
              max_tokens: 32768, // Crucial for large reports (32KB+)
              // Remove penalties: they cause "stuttering" (......) when models try to output
              // repetitive technical content or markdown separators.
              //frequency_penalty: 0,
              //presence_penalty: 0,
              top_p: 0.9,
              // Tighten stop sequences: only use unambiguous end-of-turn markers.
              // We avoid '\nuser\n' because it can occur naturally in markdown reports.
              stop: [
                '<|im_end|>',
                '<|end|>',
                '<|start|>',
                '<|start|>assistant',
                '<|start|>system',
                '<|start|>user'
              ],
              skip_special_tokens: true
            });
          break;
        } catch (error) {
          const msg = (error && error.message) ? error.message : '';

          // Noise reduction: Filter out periodic SSE timeouts or generic fetch errors
          // unless DOKODEMODOOR_DEBUG is enabled.
          const isNoisyError =
            msg.includes('SSE timeout') ||
            msg.includes('network error') ||
            msg.includes('fetch failed') ||
            msg.includes('Connection error') ||
            msg.includes('ECONNRESET');

          if (isNoisyError && !dokodemodoorConfig.dokodemodoor.debug) {
            // Silently retry or throw with a cleaner message
            if (attempt === 0) {
               console.log(chalk.gray(`    🕒 vLLM connection intermittent, retrying...`));
               continue;
            }
          }

          const isToolParseError =
            msg.includes('Error decoding JSON tool call') ||
            msg.includes('JSONDecodeError') ||
            (msg.includes('tool') && msg.includes('JSON'));

          if (attempt === 0 && isToolParseError) {
            console.log(chalk.yellow('    ⚠️ vLLM tool-call JSON parse error detected. Retrying with tool_choice=none...'));
            toolChoice = 'none';
            extraSystemMsg = '[TOOL JSON ERROR RECOVERY] If you need to call a tool, output a single valid JSON object inside a ```json code block``` with the tool name and arguments. Do not include any extra text in that block.';
            continue;
          }

          throw error;
        }
      }

      if (response && response.usage) {
        cumulativeUsage.prompt_tokens += response.usage.prompt_tokens || 0;
        cumulativeUsage.completion_tokens += response.usage.completion_tokens || 0;
        cumulativeUsage.total_tokens += response.usage.total_tokens || 0;
      }

      if (!response) {
        throw new Error('vLLM Provider error: Failed to obtain response after tool-call JSON parse recovery.');
      }

      try {

        const choice = response.choices[0];
        const message = choice.message;
        const content = (message.content || '').trim();

        // Extract tool calls from markdown blocks if present (Hallucination Defense & Truncation Recovery)
        // LENIENT REGEX: Match the start of a block even if the closing ``` is missing
        const jsonBlocks = content.match(/```(?:json|jsonc)?\s*(\{[\s\S]*?)(?:```|$)/g);
        if (jsonBlocks) {
          if (!message.tool_calls) message.tool_calls = [];
          jsonBlocks.forEach((block, idx) => {
            try {
              let cleaned = block.replace(/```(?:json|jsonc)?/, '').replace(/```$/, '').trim();

              // Attempt to repair if truncated (missing closing brace)
              if (!cleaned.endsWith('}')) {
                cleaned = this.repairTruncatedJSON(cleaned);
              }

              const parsed = this.safeJSONParse(cleaned, null, agentName);
              const tid = `text_id_${turnCount}_${idx}`;
              const detectedTool = (parsed && parsed.__toolName) || null;

              if (parsed && (detectedTool === 'save_deliverable' || parsed.deliverable_type || parsed.path)) {
                // ... same logic for deliverable_type ...
                if (!parsed.deliverable_type && parsed.vulnerabilities && Array.isArray(parsed.vulnerabilities)) {
                   const agentLow = agentName.toLowerCase();
                   if (agentLow.includes('sqli')) parsed.deliverable_type = 'SQLI_QUEUE';
                   else if (agentLow.includes('xss')) parsed.deliverable_type = 'XSS_QUEUE';
                   else if (agentLow.includes('ssti')) parsed.deliverable_type = 'SSTI_QUEUE';
                   else if (agentLow.includes('osv')) parsed.deliverable_type = 'OSV_QUEUE';
                   else parsed.deliverable_type = 'INJECTION_QUEUE';
                }

                if (parsed.path && !parsed.deliverable_type) {
                   const filename = path.basename(parsed.path);
                   if (filename.includes('recon')) parsed.deliverable_type = 'RECON';
                   else if (filename.includes('analysis')) {
                     const agentLow = (agentName || '').toLowerCase();
                     if (agentLow.includes('xss')) parsed.deliverable_type = 'XSS_ANALYSIS';
                     else if (agentLow.includes('osv')) parsed.deliverable_type = 'OSV_REPORT';
                     else if (agentLow.includes('sqli')) parsed.deliverable_type = 'SQL_ANALYSIS';
                     else if (agentLow.includes('fuzzer') || agentLow.includes('api')) parsed.deliverable_type = 'API_FUZZ_REPORT';
                     else parsed.deliverable_type = 'CODE_ANALYSIS';
                   }
                   else if (filename.includes('queue')) {
                     const agentLow = (agentName || '').toLowerCase();
                     if (agentLow.includes('osv')) parsed.deliverable_type = 'OSV_QUEUE';
                     else parsed.deliverable_type = 'INJECTION_QUEUE';
                   }
                }
                if (parsed.deliverable_type) {
                  delete parsed.__toolName;
                  message.tool_calls.push({ id: tid, type: 'function', function: { name: 'save_deliverable', arguments: JSON.stringify(parsed) } });
                }
              } else if (parsed && (detectedTool === 'bash' || detectedTool === 'execute_command' || parsed.command)) {
                delete parsed.__toolName;
                message.tool_calls.push({ id: tid, type: 'function', function: { name: 'bash', arguments: JSON.stringify(parsed) } });
              } else if (parsed && (detectedTool === 'TodoWrite' || detectedTool === 'Todo' || parsed.todo)) {
                delete parsed.__toolName;
                message.tool_calls.push({ id: tid, type: 'function', function: { name: 'TodoWrite', arguments: JSON.stringify(parsed) } });
              } else if (parsed && (detectedTool === 'TaskAgent' || (parsed.task && parsed.input))) {
                delete parsed.__toolName;
                message.tool_calls.push({ id: tid, type: 'function', function: { name: 'TaskAgent', arguments: JSON.stringify(parsed) } });
              }
            } catch (e) {
              console.log(chalk.gray(`    ⚠️  Lenient JSON parse failed: ${e.message.slice(0, 100)}...`));
            }
          });
        }

        const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;

        if (hasToolCalls) {
          messages.push(message);
          yield { type: 'assistant', message: { role: 'assistant', content: message.content || '' } };

          const validToolCalls = [];
          const immediateResults = [];

          for (const tc of message.tool_calls) {
            let toolName = tc.function.name.split(/[<|\[?!\s…\.]/)[0].trim();
            if (toolName === 'Todo') toolName = 'TodoWrite';
            if (['Tool', 'Task'].includes(toolName)) toolName = 'TaskAgent';
            if (toolName === 'execute_command') toolName = 'bash';
            if (toolName === 'browse_file') toolName = 'open_file';

            try {
              const args = this.safeJSONParse(tc.function.arguments, toolName, agentName);

              if (toolName === 'TaskAgent') {
                const findings = this.extractFindings(messages, agentName, targetDir);
                const taskKey = (args.task || args.input || '').toLowerCase().trim();
                const isDone = findings.doneTasks.has(taskKey);

                if (isDone) {
                   console.log(chalk.bold.green(`    ♻️  REUSING CACHED FINDING: ${args.task || args.input}`));
                   immediateResults.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: JSON.stringify({ status: 'complete', message: 'Task already completed. Refer to staged findings.', isComplete: true }) });
                   continue;
                }
              }

              if (toolName === 'save_deliverable') {
                args.deliverable_type = this.getForcedDeliverableType(agentName, args.deliverable_type);
              }

              if (toolName === 'bash' && args.command && typeof args.command === 'string') {
                // Defensive: Strip LLM hallucinations like "command: ls" or "bash: ls"
                args.command = args.command.replace(/^(command|bash|sh):\s*/i, '').trim();
              }

              validToolCalls.push({ id: tc.id, name: toolName, arguments: args });
            } catch (e) {
              immediateResults.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: JSON.stringify({ status: 'error', message: `Parse error: ${e.message}` }) });
            }
          }

          for (const tc of validToolCalls) yield { type: 'tool_use', name: tc.name, input: tc.arguments };
          const actual = await runWithContext({ agentName, targetDir }, () => executeToolCalls(validToolCalls, registry));

          for (let i = 0; i < validToolCalls.length; i++) {
            const tc = validToolCalls[i];
            const res = actual[i];

            if (tc.name === 'TaskAgent' && res.content) {
              try {
                const resultObj = typeof res.content === 'string' ? JSON.parse(res.content) : res.content;
                const isFinished = resultObj.status === 'complete' || resultObj.status === 'success' || resultObj.isComplete;
                if (isFinished) {
                   const missionDir = this.getMissionDir(targetDir, missionName, agentName);
                   if (!fs.existsSync(missionDir)) fs.mkdirSync(missionDir, { recursive: true });
                   const taskName = (tc.arguments.task || tc.arguments.input);
                   const safeTask = taskName.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 30);
                   const filePath = path.join(missionDir, `finding_${Date.now()}_${safeTask}.md`);
                   fs.writeFileSync(filePath, `# Finding: ${taskName}\n\n${resultObj.result || resultObj.output || resultObj.findings || ''}`);

                   // Auto-tick todo.txt
                   const todoPath = path.join(missionDir, 'todo.txt');
                   if (fs.existsSync(todoPath)) {
                      let todoContent = fs.readFileSync(todoPath, 'utf8');
                      const lines = todoContent.split('\n');
                      const taskName = (tc.arguments.task || tc.arguments.input || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                      let updated = false;
                      const newLines = lines.map(line => {
                        if (updated) return line;
                        const lineNorm = line.toLowerCase().replace(/[^a-z0-9]/g, '');
                        // Improved matching: Look for word overlap/partial match
                        const isMatch = lineNorm.includes(taskName) || taskName.includes(lineNorm.replace('phase', '').replace('verify', ''));
                        if (lineNorm && isMatch) {
                          updated = true;
                          return line.replace('[ ]', '[✓]').replace('[-]', '[✓]');
                        }
                        return line;
                      });
                      if (updated) {
                         fs.writeFileSync(todoPath, newLines.join('\n'));
                         console.log(chalk.blue(`    ✅ Auto-ticked todo.txt for: ${tc.arguments.task}`));
                      }
                   }
                }
              } catch(e) {}
            }

            if (tc.name === 'TodoWrite' && tc.arguments.todo) {
              const missionDir = this.getMissionDir(targetDir, missionName, agentName);
              if (!fs.existsSync(missionDir)) fs.mkdirSync(missionDir, { recursive: true });
              fs.writeFileSync(path.join(missionDir, 'todo.txt'), tc.arguments.todo);
              console.log(chalk.blue(`    💾 Persisted todo.txt for ${missionName}`));
            }

            if (tc.name === 'save_deliverable') {
              try {
                let resContent = typeof res.content === 'string' ? JSON.parse(res.content) : res.content;
                if (resContent && !resContent.status && Array.isArray(resContent.content)) {
                  const textItem = resContent.content.find(item => typeof item.text === 'string');
                  if (textItem) {
                    try {
                      resContent = JSON.parse(textItem.text);
                    } catch (e) {}
                  }
                }
                const isSuccess = resContent?.status === 'success' || resContent?.isError === false;
                if (isSuccess || !resContent?.status) savedTypes.add(tc.arguments.deliverable_type);
                const name = (agentName || '').toLowerCase();
                if (name.includes('report') && tc.arguments.deliverable_type === 'FINAL_REPORT' && isSuccess) {
                  finished = true;
                  yield {
                    type: 'result',
                    result: 'REPORTING COMPLETE',
                    subtype: 'success',
                    duration_ms: Date.now() - startTime,
                    usage: cumulativeUsage,
                    total_cost_usd: this.calculateCost(cumulativeUsage)
                  };
                  return;
                }
              } catch(e) {}
            }

            if (tc.name === 'open_file' && res.content && res.content.length > 3000) {
               const missionDir = this.getMissionDir(targetDir, missionName, agentName);
               if (!fs.existsSync(missionDir)) fs.mkdirSync(missionDir, { recursive: true });
               const targetName = tc.arguments.path.split('/').pop().replace(/[^a-z0-9]/g, '_').substring(0, 30);
               const filePath = path.join(missionDir, `staged_source_${targetName}.md`);
               if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, `# Staged: ${tc.arguments.path}\n\n\`\`\`\n${res.content}\n\`\`\``);
            }
          }

          messages.push(...actual);
          for (const res of actual) yield { type: 'tool_result', content: res.content };
          continue;
        }

        if (choice.finish_reason === 'stop') {
           if (!content && !hasToolCalls) {
             console.log(chalk.yellow(`    ⚠️ Empty response detected. Nudging (Attempt ${nudgeCount + 1}/2)...`));
             if (nudgeCount++ < 2) {
               const nudge = { role: 'user', content: `[SYSTEM NOTICE] You provided an empty response. Please continue analysis or provide ## Summary.` };
               messages.push(message, nudge);
               yield { type: 'assistant', message: { role: 'system', content: nudge.content } };
               continue;
             } else { throw new Error("Agent stuck in silence."); }
           }

           // [COMPLETION GUARD] Specialist agents MUST save their deliverables
           const name = (agentName || '').toLowerCase();
           if (!name.startsWith('sub-agent-')) {
             const currentSaved = Array.from(savedTypes);
             let missing = null;

             if (name.includes('vuln')) {
               const hasAnalysis = currentSaved.some(t => t.includes('ANALYSIS'));
               const hasQueue = currentSaved.some(t => t.includes('QUEUE'));
               if (!hasAnalysis || !hasQueue) {
                 missing = !hasAnalysis ? 'ANALYSIS (Markdown report)' : 'QUEUE (JSON exploitation list)';
               }
             } else if (name.includes('exploit') && !currentSaved.some(t => t.includes('EVIDENCE'))) {
                missing = 'EVIDENCE (JSON exploitation report)';
             } else if (name.includes('pre-recon') && !currentSaved.includes('CODE_ANALYSIS')) {
                missing = 'CODE_ANALYSIS';
             } else if (name.includes('recon-verify') && !currentSaved.includes('RECON_VERIFY')) {
                missing = 'RECON_VERIFY';
             } else if (name.includes('recon') && !name.includes('pre-recon') && !name.includes('recon-verify') && !currentSaved.includes('RECON')) {
                missing = 'RECON';
              } else if (name.includes('osv-analysis')) {
                const hasReport = currentSaved.includes('OSV_REPORT');
                const hasQueue = currentSaved.includes('OSV_QUEUE');
                if (!hasReport || !hasQueue) {
                  missing = !hasReport ? 'OSV_REPORT (Markdown)' : 'OSV_QUEUE (JSON)';
                }
              }

             if (missing) {
               const isNearEnd = turnCount >= maxTurns - 1;
               if (isNearEnd) allowGraceTurns = true;

               let nudgeText = `[CRITICAL] You are finishing but you haven't saved the ${missing} file yet. ${isNearEnd ? 'TURN LIMIT REACHED (GRACE PERIOD GRANTED).' : ''} You MUST call save_deliverable for ${missing} before providing ## Summary.`;

               // ADDED: Special advice for large reports likely to hit truncation limits
               if (missing === 'RECON' && turnCount > 5) {
                 nudgeText += `\n\nPRO TIP: If your report is very large (API lists, etc.), the JSON tool call might get truncated. Consider using 'bash' to write the file directly using 'cat <<EOF > deliverables/recon_deliverable.md' or simplifying the table.`;
               }

               const nudge = { role: 'user', content: nudgeText };
               messages.push(message, nudge);
               yield { type: 'assistant', message: { role: 'assistant', content: message.content || '' } };
               yield { type: 'assistant', message: { role: 'system', content: nudge.content } };
               continue;
             }
           }

           if (content) {
             yield { type: 'assistant', message: { role: 'assistant', content } };
           }
           messages.push(message);
           finished = true;
           yield { type: 'result', result: content, subtype: 'success', duration_ms: Date.now() - startTime, usage: cumulativeUsage, total_cost_usd: this.calculateCost(cumulativeUsage) };
           break;
        }
      } catch (error) {
        console.error(chalk.red(`vLLM Provider error: ${error.message}`));
        throw error;
      }
    }
  }

  /**
   * [목적] 잘린 JSON 응답을 복구 시도합니다 (괄호 밸런싱).
   */
  repairTruncatedJSON(jsonStr) {
    let repaired = jsonStr.trim();

    // 1. Remove trailing incomplete property keys or values
    repaired = repaired.replace(/,\s*$/, '');
    repaired = repaired.replace(/":\s*$/, '');

    // 2. Close unterminated strings
    const quoteCount = (repaired.match(/"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      repaired += '"';
    }

    // 3. Balance braces and brackets
    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;
    for (let i = 0; i < (openBraces - closeBraces); i++) repaired += '}';

    const openBrackets = (repaired.match(/\[/g) || []).length;
    const closeBrackets = (repaired.match(/\]/g) || []).length;
    for (let i = 0; i < (openBrackets - closeBrackets); i++) repaired += ']';

    return repaired;
  }

  /**
   * [목적] 추출된 요약을 활용해 대화 기록을 압축.
   */
  compressHistory(messages, agentName = 'generic', targetDir = '.') {
    const threshold = dokodemodoorConfig.dokodemodoor.contextCompressionThreshold || 50000;
    if (JSON.stringify(messages).length < threshold) return messages;

    console.log(chalk.yellow(`    ⚠️  History large. Compressing...`));
    const findings = this.extractFindings(messages, agentName, targetDir);

    const isExploit = (agentName || '').toLowerCase().includes('exploit');
    const window = isExploit ? 30 : (dokodemodoorConfig.dokodemodoor.contextCompressionWindow || 15);
    const initial = messages[0];
    const recent = messages.slice(-window);
    const marker = {
      role: 'user',
      content: `[HISTORY COMPRESSED]\n\n**STATUS:**\n- Completed: ${Array.from(findings.doneTasks).join(', ')}\n- Staged: ${findings.stagedFiles.length} files\n- Todo:\n${findings.lastTodo}\n\nContinue from the latest state.`
    };

    messages.length = 0;
    messages.push(initial, marker, ...recent);
    return messages;
  }
}
