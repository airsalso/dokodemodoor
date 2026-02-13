# Reverse Engineering Phase 구현 계획서

> 작성일: 2026-02-13
> 최종 수정: 2026-02-13
> 상태: Phase 4 네트워크 분석 완성 (전 Phase 코드 구현 완료)

---

## 1. 배경 및 목적

DokodemoDoor는 웹 애플리케이션 대상의 자동화 펜테스트 파이프라인(22개 에이전트)을 보유하고 있다.
본 계획은 **PE/ELF 바이너리 리버스 엔지니어링** 파이프라인을 추가하여,
MCP 서버 기반 에이전트들이 바이너리의 정적/동적 분석을 자율적으로 수행하도록 플랫폼을 확장하는 것이다.
DokodemoDoor는 Ubuntu에서 실행되며, 분석 대상은 PE (Windows)와 ELF (Linux) 바이너리 모두를 지원한다.

### 핵심 원칙
- GUI 자동화 없이(또는 최소화로) **분석 → 관찰 → 증적 → 리포트** 파이프라인 구성
- 관찰 중심(Observation-Only): 바이너리를 수정하지 않고 관찰과 기록만 수행
- 기존 인프라(세션, 체크포인트, 감사 로그) 최대 재활용

---

## 2. 아키텍처 결정

### 2.1 별도 엔트리포인트 (OSV 패턴)

| 항목 | 결정 | 근거 |
|------|------|------|
| 파이프라인 통합 방식 | 별도 엔트리포인트 (`re-scanner.mjs`) | 타겟 입력이 근본적으로 다름 (URL+소스 vs 바이너리 경로) |
| MVP 범위 | Sigcheck/DiE + Ghidra MCP 먼저 | 핵심 가치이면서 빌드 난이도가 낮은 조합 |
| MCP 서버 위치 | `mcp-servers/` 디렉토리 | 기존 `mcp-server/`(dokodemodoor-helper)와 구분 |

### 2.2 왜 기존 CLI에 통합하지 않는가

- 웹 펜테스트는 `(webUrl, repoPath)` 입력, RE는 `(binaryPath, symbolsPath)` 입력
- 기존 에이전트들과 선행 조건(prerequisites)이 완전히 독립
- OSV 분석이 이미 `osv-scanner.mjs`로 별도 운영되는 검증된 패턴

---

## 3. 전체 파이프라인 아키텍처

```
Phase 1: Pre-Inventory     → re-inventory     (sigcheck64/file+readelf + DiE MCP)
Phase 2: Static Analysis    → re-static        (Ghidra MCP)
Phase 3: Dynamic Obs.       → re-dynamic       (ProcMon/strace + WinDbg/gdb MCP) ─┐ 병렬
                            → re-instrument    (Frida MCP)                         ─┘
Phase 4: Network Analysis   → re-network       (tshark MCP)
Phase 5: RE Reporting       → re-report        (dokodemodoor-helper)
```

### 3.1 에이전트 구조

| Agent | Phase | Order | Prerequisites | MCP 서버 |
|-------|-------|-------|---------------|----------|
| `re-inventory` | re-inventory | 101 | (없음) | re-sigcheck (sigcheck64/file+readelf + DiE) |
| `re-static` | re-static-analysis | 102 | re-inventory | re-ghidra |
| `re-dynamic` | re-dynamic-observation | 103 | re-static | re-procmon (ProcMon/strace + WinDbg/gdb) |
| `re-instrument` | re-dynamic-observation | 104 | re-static | re-frida |
| `re-network` | re-network-analysis | 105 | re-dynamic, re-instrument | re-tshark |
| `re-report` | re-reporting | 106 | re-network | dokodemodoor-helper |

### 3.2 데이터 흐름

```
re-inventory
  └─▶ re_inventory_deliverable.md (바이너리 프로필)
        │
re-static
  ├─▶ re_static_analysis_deliverable.md (정적 분석 보고서)
  └─▶ re_observation_candidates.json (관찰 후보 구조화 JSON)
        │
  ┌─────┴─────┐
re-dynamic   re-instrument (병렬)
  │             │
  ▼             ▼
re_dynamic_observation_deliverable.md   re_instrumentation_deliverable.md
re_behavioral_log.json                  re_hook_logs.json
  │             │
  └─────┬─────┘
        │
re-network
  ├─▶ re_network_analysis_deliverable.md
  └─▶ re_network_sessions.json
        │
re-report
  └─▶ re_comprehensive_report.md (최종 보고서)
```

---

## 4. MCP 서버 아키텍처

### 4.1 설계 원칙: 도구별 독립 MCP 서버

각 외부 도구를 독립 MCP 서버로 래핑하는 방식 채택.

| MCP 서버 | 도구 | 노출 도구 수 | 빌드 난이도 |
|----------|------|-------------|------------|
| `re-sigcheck-mcp` | sigcheck64 (Win) / file+readelf (Linux) + DiE | 3개 | 낮음 (CLI spawn+parse) |
| `re-ghidra-mcp` | **bethington/ghidra-mcp** (Ghidra GUI Plugin + Python bridge) | **110개** | 낮음 (커뮤니티 플러그인 활용) |
| `re-windbg-mcp` | WinDbg/CDB (Win) / gdb (Linux) | 7개 | 높음 (대화형 세션 관리) |
| `re-procmon-mcp` | ProcMon (Win) / strace (Linux) | 4개 | 중간 (CSV 파싱) |
| `re-frida-mcp` | Frida | 7개 | 중간 (frida-node 바인딩) |
| `re-tshark-mcp` | tshark | 6개 | 낮음-중간 (JSON 출력) |

### 4.2 re-ghidra-mcp 아키텍처 (bethington/ghidra-mcp 기반)

MVP에서 자체 GhidraScript 브릿지 방식을 설계했으나, 커뮤니티 프로젝트 [bethington/ghidra-mcp](https://github.com/bethington/ghidra-mcp)을 도입하여 **110개 도구**를 확보하였다.

#### 아키텍처 (옵션 C: Xvfb + GUI Plugin)

```
re-static agent
  ↓ MCP stdio
bridge-wrapper.js (Node.js 래퍼)
  ↓ stdin/stdout pipe
bridge_mcp_ghidra.py (Python MCP ↔ HTTP 변환)
  ↓ HTTP :8080
Ghidra GUI + GhidraMCP Plugin (Xvfb 가상 디스플레이 위)
```

- **운영 환경**: 네이티브 Ubuntu GUI → Ghidra GUI 직접 실행 (Xvfb 불필요)
- **서버 모드**: Ghidra 상시 구동, HTTP REST API로 110개 분석 기능 노출
- **bridge-wrapper.js**: DokodemoDoor의 stdio MCP 인터페이스를 유지하면서 Python bridge와 연결

#### 도입 근거

| 항목 | 자체 GhidraScript (이전) | bethington/ghidra-mcp (현재) |
|------|------------------------|---------------------------|
| 도구 수 | 7개 (미구현) | **110개 (즉시 사용 가능)** |
| GhidraScript | 6개 Java 파일 필요 | 불필요 (플러그인 내장) |
| 콜그래프 | 미지원 | 지원 (call_graph, callers, callees) |
| 구조체/타입 | 미지원 | 완전 지원 (생성/수정/삭제) |
| 배치 연산 | 미지원 | 지원 (API 호출 93% 절감) |
| 리네이밍/문서화 | 미지원 | 지원 (분석 결과 Ghidra에 반영) |

### 4.3 MCP 서버별 도구 상세

#### re-sigcheck-mcp (구현 완료)
```
sigcheck_analyze  — 디지털 서명 검증 (sigcheck64 (Win) / file+readelf (Linux))
die_scan          — 패킹/컴파일러/런타임 탐지 (diec --json)
binary_info       — 바이너리 헤더 기본 정보 (diec --json --deep)
```

#### re-ghidra-mcp (구현 완료 — bethington/ghidra-mcp 110개 도구)

**핵심 분석 도구**:
```
check_connection         — Ghidra MCP 서버 연결 확인
get_metadata             — 바이너리 메타데이터
list_functions           — 전체 함수 목록 (페이지네이션)
search_functions_by_name — 함수 이름/패턴 검색
search_functions_enhanced — 고급 복합 필터 검색
decompile_function       — 함수 디컴파일 (C 의사코드)
list_imports             — Import 심볼 및 라이브러리
list_exports             — Export 심볼
list_strings             — 문자열 추출 및 분류
get_xrefs_to / get_xrefs_from / get_bulk_xrefs — 교차참조
get_entry_points         — 엔트리 포인트
```

**콜그래프 분석 도구**:
```
get_function_callers     — 호출자 목록
get_function_callees     — 피호출자 목록
get_function_call_graph  — 함수 단위 콜그래프
analyze_function_complete — 종합 분석 (디컴파일+xref+변수 일괄)
```

**메모리/데이터 분석 도구**:
```
list_segments            — 메모리 세그먼트 레이아웃
disassemble_function     — 어셈블리 디스어셈블리
analyze_data_region      — 메모리 영역 구조 분석
search_byte_patterns     — 바이트 시그니처 검색
```

**리네이밍/문서화 도구**:
```
rename_function          — 함수 이름 변경
set_decompiler_comment   — 디컴파일러 주석
batch_rename_function_components — 일괄 리네이밍
batch_set_comments       — 일괄 주석 추가
rename_variables         — 변수 이름 변경
```

> 전체 110개 도구 목록은 [bethington/ghidra-mcp README](https://github.com/bethington/ghidra-mcp) 참조.

#### re-procmon-mcp (구현 완료) — ProcMon (Windows) / strace (Linux)
```
procmon_start_capture — 캡처 시작 (필터 포함)
procmon_stop_capture  — 캡처 중지 + CSV/XML 내보내기
procmon_get_events    — 캡처 이벤트 파싱
procmon_set_filter    — 필터 설정
```

#### re-windbg-mcp (구현 완료) — WinDbg/CDB (Windows) / gdb (Linux)
```
cdb_run_command    — CDB/gdb 명령 실행
cdb_attach_process — 프로세스 연결
cdb_set_breakpoint — 브레이크포인트 설정
cdb_list_exceptions — 예외 목록
cdb_list_modules   — 모듈 목록
cdb_list_threads   — 스레드 목록 + 스택
cdb_capture_crash  — 크래시 덤프 캡처
```

#### re-frida-mcp (구현 완료)
```
frida_attach        — 프로세스 연결
frida_hook_function — 함수 훅 설치
frida_list_modules  — 모듈 목록
frida_list_exports  — 모듈 export 목록
frida_inject_script — 커스텀 스크립트 삽입
frida_get_logs      — 수집 로그 가져오기
frida_unhook        — 훅 제거
```

#### re-tshark-mcp (구현 완료)
```
tshark_start_capture      — 캡처 시작 (인터페이스, BPF 필터, 시간/패킷 제한)
tshark_stop_capture       — 캡처 중지 + PCAP 통계 요약
tshark_analyze_capture    — PCAP 분석 (summary/protocols/endpoints/conversations/expert)
tshark_get_http_streams   — HTTP 요청/응답 스트림 추출
tshark_get_dns_queries    — DNS 쿼리/응답 추출 + 도메인 집계
tshark_get_tls_handshakes — TLS 핸드셰이크 분석 (SNI, 버전, 암호 스위트)
```

---

## 5. 핵심 데이터 구조: observation_candidates.json

정적 분석(Phase 2) → 동적 관찰(Phase 3)로 넘어가는 핵심 인터페이스:

```json
{
  "binary": "sample-app",
  "binary_format": "ELF",
  "analysis_timestamp": "2026-02-13T10:00:00Z",
  "total_candidates": 12,
  "candidates": [
    {
      "id": "candidate_001",
      "category": "network",
      "function_name": "connect",
      "module": "libc.so.6",
      "address": "0x00401234",
      "evidence": "Cross-ref from sub_401000, string ref 'https://api.example.com'",
      "priority": "high",
      "suggested_hooks": ["entry_args", "return_value", "callstack"],
      "decompile_summary": "소켓 연결을 수행하여 원격 서버 통신"
    }
  ]
}
```

### 카테고리 분류 체계

| 카테고리 | 설명 | 대표 함수/패턴 |
|----------|------|----------------|
| `network` | 네트워크 통신 | WinHttp*, WSA*, socket, connect, send, recv, curl_* |
| `authentication` | 인증/세션 | Login, Auth, Token, Credential, PAM_* |
| `cryptography` | 암호화/복호화 | Crypt*, BCrypt*, AES, RSA, EVP_*, SSL_* |
| `license` | 라이선스 검증 | License, Serial, Activate |
| `update` | 자동 업데이트 | Update, Download, Version |
| `anti-tamper` | 무결성 검증 | IsDebugger, ptrace, CRC, Checksum |

---

## 6. 구현 로드맵

### Phase 1: MVP (완료)
- Core Infrastructure (session-manager, constants, agent-executor, deliverables, prompt-manager)
- re-scanner.mjs 엔트리포인트
- src/phases/re-analysis.js 오케스트레이터
- re-sigcheck-mcp 서버
- re-ghidra-mcp 서버 (자체 GhidraScript 방식, 미동작)
- 3개 MVP 프롬프트 (re-inventory, re-static, re-report)
- 3개 스켈레톤 프롬프트 (re-dynamic, re-instrument, re-network)
- 설정 스키마, 예시 프로필

### Phase 2: Ghidra 완성 (완료 — bethington/ghidra-mcp 도입)
- ~~GhidraScript 6개 Java 파일 구현~~ → bethington/ghidra-mcp 플러그인으로 대체
- bridge-wrapper.js (stdio MCP 래퍼) 구현
- re-static.txt 프롬프트 확장 (110개 도구 활용, 콜그래프/배치/리네이밍 단계 추가)
- Ghidra MCP 서비스 자동화 스크립트 (setup-ghidra-mcp.sh, start-ghidra-mcp.sh)
- configs/mcp/re-tools.json, configs/profile/sample-re.yaml 업데이트
- E2E 테스트: 운영 환경(Ubuntu GUI)에서 수행 예정

### Phase 3: 동적 분석 (완료)
- re-procmon-mcp (strace 래퍼, 4개 도구: start/stop/get_events/set_filter)
- re-windbg-mcp (gdb/MI 래퍼, 7개 도구: attach/command/breakpoint/modules/threads/exceptions/crash)
- re-frida-mcp (frida-node, 7개 도구: attach/hook/modules/exports/inject/logs/unhook)
- re-dynamic.txt, re-instrument.txt 프롬프트 완성

### Phase 4: 네트워크 분석 (완료)
- re-tshark-mcp (tshark CLI 래퍼, 6개 도구: start/stop/analyze/http_streams/dns_queries/tls_handshakes)
- re-network.txt 프롬프트 완성 (캡처 전략, 다회 캡처, 6개 분석 단계, 보안 판단, 교차 검증)
- E2E 테스트: 운영 환경(Ubuntu GUI)에서 수행 예정

---

## 7. 기존 패턴과의 일관성

| 기존 패턴 | RE 적용 |
|-----------|---------|
| `osv-scanner.mjs` 별도 엔트리 | `re-scanner.mjs` 별도 엔트리 |
| `AGENTS` 객체에 등록 | 6개 RE 에이전트 등록 (order 101-106) |
| `PHASES` + `PHASE_ORDER` | `RE_PHASES` + `RE_PHASE_ORDER` 별도 export |
| `AGENT_VALIDATORS` 검증 | 6개 RE validator (파일 존재 체크) |
| `MCP_AGENT_MAPPING` 매핑 | 6개 RE agent → MCP 매핑 |
| `PHASE_TOOL_REQUIREMENTS` | RE phases 모두 `playwright: false` |
| `DeliverableType` enum | 10개 RE deliverable 타입 추가 |
| `save_deliverable` 도구 | 동일 도구 사용, 새 타입명으로 저장 |
| git checkpoint 시스템 | 동일 — 각 에이전트 완료 시 커밋 |
| 병렬 실행 | `re-dynamic-observation` phase에서 2개 에이전트 병렬 |
