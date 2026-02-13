# Reverse Engineering Phase 작업 결과 보고서

> 작성일: 2026-02-13
> 최종 수정: 2026-02-13
> 상태: Phase 4 네트워크 분석 완성 (전 Phase 코드 구현 완료)

---

## 1. 작업 개요

DokodemoDoor 플랫폼에 PE/ELF 바이너리 리버스 엔지니어링 파이프라인을 추가하는 작업을 수행하였다.
6개 에이전트, 5개 페이즈로 구성된 RE 파이프라인의 코어 인프라와 MVP 범위(sigcheck64/file+readelf + DiE + Ghidra) MCP 서버를 구현하였다.
DokodemoDoor는 Ubuntu에서 실행되며, PE (Windows)와 ELF (Linux) 바이너리 모두를 분석 대상으로 지원한다.

### MVP 범위

```
re-inventory (Sigcheck/DiE) → re-static (Ghidra) → re-report (종합 보고서)
```

### 구현 방식 결정

| 항목 | 결정 | 근거 |
|------|------|------|
| 파이프라인 통합 | 별도 엔트리포인트 (`re-scanner.mjs`) | 타겟 입력이 근본적으로 다름 (URL vs 바이너리 경로) |
| MVP 범위 | Sigcheck/DiE + Ghidra MCP 먼저 | 핵심 가치이면서 빌드 난이도가 낮은 조합 |
| MCP 서버 위치 | `mcp-servers/` 디렉토리 | 기존 `mcp-server/`(dokodemodoor-helper)와 구분 |

---

## 2. 수정된 기존 파일 (8개)

### 2.1 `src/session-manager.js`

**변경 내용**: RE 에이전트 6개 등록 + `RE_PHASES`, `RE_PHASE_ORDER` export 추가

- `AGENTS` 객체에 `re-inventory`, `re-static`, `re-dynamic`, `re-instrument`, `re-network`, `re-report` 추가 (order 101~106)
- `RE_PHASES`: RE 전용 phase → agent 매핑 (5개 phase)
- `RE_PHASE_ORDER`: RE phase 실행 순서 배열
- `getPhaseIndexForAgent()`: RE 에이전트는 `return 100`으로 바이패스 (웹 파이프라인과 분리)
- `getNextAgent()`: RE 에이전트를 웹 시퀀스에서 제외하는 필터 추가

### 2.2 `src/constants.js`

**변경 내용**: 3개 상수 객체에 RE 항목 추가

- **`PHASE_TOOL_REQUIREMENTS`**: RE 5개 phase 모두 `playwright: false`
- **`MCP_AGENT_MAPPING`**: RE agent → MCP 서버 매핑 (re-inventory→re-sigcheck, re-static→re-ghidra, 등)
- **`AGENT_VALIDATORS`**: RE 6개 agent의 deliverable 파일 존재 확인 validator

### 2.3 `src/ai/agent-executor.js`

**변경 내용**: `getAgentPhase()` 함수에 RE agent 정적 매핑 추가

- `rePhaseMap` 객체로 RE agent → phase 매핑 (비동기 import 없이 정적 해결)
- 기존 웹 에이전트 로직에 영향 없음

### 2.4 `mcp-server/src/types/deliverables.js`

**변경 내용**: 10개 RE deliverable 타입 추가

- `DeliverableType` enum: `RE_INVENTORY`, `RE_STATIC_ANALYSIS`, `RE_OBSERVATION_CANDIDATES`, `RE_DYNAMIC_OBSERVATION`, `RE_BEHAVIORAL_LOG`, `RE_INSTRUMENTATION`, `RE_HOOK_LOGS`, `RE_NETWORK_ANALYSIS`, `RE_NETWORK_SESSIONS`, `RE_COMPREHENSIVE_REPORT`
- `DELIVERABLE_FILENAMES` 매핑: 각 타입에 대응하는 파일명 등록

### 2.5 `src/prompts/prompt-manager.js`

**변경 내용**: RE 전용 변수 보간 4개 추가

- `{{BINARY_PATH}}` → `variables.binaryPath`
- `{{SYMBOLS_PATH}}` → `variables.symbolsPath`
- `{{PROCESS_NAME}}` → `variables.processName`
- `{{ANALYSIS_FOCUS}}` → `variables.analysisFocus`

### 2.6 `configs/config-schema.json`

**변경 내용**: `reverse_engineering` JSON Schema 속성 추가

- `binary_path` (string, 필수): 분석 대상 바이너리 경로
- `symbols_path` (string, 선택): PDB (Windows) / DWARF 디버그 심볼 (Linux) 경로
- `process_name` (string, 선택): 동적 분석 시 프로세스 이름
- `launch_args` (string[], 선택): 프로세스 실행 인자
- `analysis_focus` (enum[], 선택): 분석 초점 카테고리 (network, authentication, cryptography, license, update, anti-tamper, file-io, registry)
- `network_interface` (string, 선택): 네트워크 캡처 인터페이스
- `ghidra_project` (string, 선택): 기존 Ghidra 프로젝트 경로

### 2.7 `src/tool-checker.js`

**변경 내용**: RE 모드 도구 가용성 체크 추가

- `checkToolAvailability(mode)` 함수에 `mode='re'` 파라미터 추가
- RE 모드 시 확인 도구: `git`, `sigcheck64` (Windows) / `file`+`readelf` (Linux), `diec`, `ghidra` (analyzeHeadless)

### 2.8 `package.json`

**변경 내용**: npm script 추가

```json
"re-scan": "node re-scanner.mjs"
```

---

## 3. 신규 생성 파일 (28개)

### 3.1 엔트리포인트 및 오케스트레이터

| 파일 | 설명 | 라인 수 |
|------|------|---------|
| `re-scanner.mjs` | RE 파이프라인 CLI 엔트리포인트 | ~227 |
| `src/phases/re-analysis.js` | RE phase 오케스트레이터 | ~197 |

**`re-scanner.mjs` 주요 기능**:
- CLI 인자 파싱 (binaryPath, --config, --phase, --agent, --help)
- 바이너리 경로 유효성 검증
- RE 작업 디렉토리 초기화 (git repo 포함)
- 세션 생성 및 config 로드
- `executeREPhases()` 호출
- SIGINT/SIGTERM 시그널 핸들링

**`src/phases/re-analysis.js` 주요 기능**:
- `executeREPhases()`: 전체 RE 파이프라인 순차/병렬 실행
- `runSingleREAgent()`: 개별 에이전트 실행 (prerequisites 확인, 프롬프트 로드, checkpoint 관리)
- `runParallelREDynamic()`: Phase 3 병렬 실행 (`Promise.allSettled`)

### 3.2 MCP 서버

| 파일 | 설명 | 노출 도구 수 |
|------|------|-------------|
| `mcp-servers/re-sigcheck-mcp/index.js` | Sigcheck/DiE MCP 서버 | 3 |
| `mcp-servers/re-sigcheck-mcp/package.json` | npm 패키지 정의 | - |
| `mcp-servers/re-ghidra-mcp/index.js` | Ghidra headless MCP 서버 (레거시, fallback용 보존) | 7 |
| `mcp-servers/re-ghidra-mcp/bridge-wrapper.js` | **[신규]** bethington/ghidra-mcp bridge 래퍼 (현재 활성) | 110 |
| `mcp-servers/re-ghidra-mcp/package.json` | npm 패키지 정의 | - |
| `mcp-servers/re-ghidra-mcp/scripts/README.md` | GhidraScript 구현 가이드 (레거시) | - |
| `mcp-servers/re-procmon-mcp/index.js` | **[Phase3]** ProcMon/strace MCP 서버 | 4 |
| `mcp-servers/re-procmon-mcp/package.json` | npm 패키지 정의 | - |
| `mcp-servers/re-windbg-mcp/index.js` | **[Phase3]** WinDbg/gdb MCP 서버 | 7 |
| `mcp-servers/re-windbg-mcp/package.json` | npm 패키지 정의 | - |
| `mcp-servers/re-frida-mcp/index.js` | **[Phase3]** Frida MCP 서버 | 7 |
| `mcp-servers/re-frida-mcp/package.json` | npm 패키지 정의 | - |
| `mcp-servers/re-tshark-mcp/index.js` | **[Phase4]** tshark MCP 서버 | 6 |
| `mcp-servers/re-tshark-mcp/package.json` | npm 패키지 정의 | - |

**re-sigcheck-mcp 도구 (3개)**:

| 도구 | 외부 명령 | 설명 |
|------|-----------|------|
| `sigcheck_analyze` | `sigcheck64 -nobanner -accepteula -a -h` (Win) / `file` + `readelf -a` (Linux) | 디지털 서명 검증 + 해시 |
| `die_scan` | `diec --json` | 패킹/컴파일러/런타임 탐지 |
| `binary_info` | `diec --json --deep` | PE/ELF 구조 상세 정보 |

**re-ghidra-mcp 도구 (110개 — bethington/ghidra-mcp)**:

> 자체 GhidraScript 브릿지 방식에서 [bethington/ghidra-mcp](https://github.com/bethington/ghidra-mcp) 플러그인으로 전환.
> `bridge-wrapper.js`가 stdio MCP 인터페이스를 유지하면서 Python bridge → Ghidra HTTP 서버로 연결.

주요 도구 카테고리:

| 카테고리 | 도구 수 | 대표 도구 |
|----------|---------|-----------|
| 핵심 분석 | 11개 | `check_connection`, `get_metadata`, `list_functions`, `decompile_function`, `list_imports`, `list_strings`, `get_xrefs_to/from` |
| 콜그래프 | 4개 | `get_function_callers`, `get_function_callees`, `get_function_call_graph`, `analyze_function_complete` |
| 메모리/데이터 | 7개 | `list_segments`, `disassemble_function`, `analyze_data_region`, `search_byte_patterns`, `get_bulk_xrefs` |
| 구조체/타입 | 12개 | `create_struct`, `add_struct_field`, `create_enum`, `apply_data_type` |
| 리네이밍/문서화 | 10개 | `rename_function`, `set_decompiler_comment`, `batch_rename_function_components`, `rename_variables` |
| 배치 연산 | 5개+ | `batch_set_comments`, `batch_create_labels`, `get_bulk_function_hashes` |
| 크로스바이너리 | 7개 | `get_function_hash`, `propagate_documentation`, `build_function_hash_index` |
| 기타 | 50개+ | 스크립트 관리, 멀티 프로그램, 라벨, 네임스페이스 등 |

### 3.3 프롬프트 파일 (6개)

| 파일 | 상태 | 설명 |
|------|------|------|
| `prompts-openai/re-inventory.txt` | **구현 완료** | Sigcheck/DiE 기반 바이너리 트리아지 |
| `prompts-openai/re-static.txt` | **구현 완료** | Ghidra 정적 분석 + observation_candidates.json 생성 |
| `prompts-openai/re-report.txt` | **구현 완료** | 전체 분석 결과 종합 보고서 |
| `prompts-openai/re-dynamic.txt` | **구현 완료** | strace/gdb 동적 관찰 (Phase 3) |
| `prompts-openai/re-instrument.txt` | **구현 완료** | Frida 런타임 계측 (Phase 3) |
| `prompts-openai/re-network.txt` | **구현 완료** | tshark 네트워크 분석 (Phase 4) |

### 3.4 공유 프래그먼트 (2개)

| 파일 | 설명 |
|------|------|
| `prompts-openai/shared/_re-scope.txt` | RE 분석 원칙 (관찰 중심, 수정 금지, 증적 수집) |
| `prompts-openai/shared/_re-target.txt` | RE 타겟 정보 템플릿 ({{BINARY_PATH}} 등) |

### 3.5 설정 파일 (2개)

| 파일 | 설명 |
|------|------|
| `configs/profile/sample-re.yaml` | RE 타겟 프로필 예시 (MCP 서버 설정 포함) |
| `configs/mcp/re-tools.json` | RE MCP 서버 6개 전체 설정 예시 |

### 3.6 서비스 스크립트 (2개, Phase 2에서 추가)

| 파일 | 설명 |
|------|------|
| `scripts/setup-ghidra-mcp.sh` | **[신규]** Ghidra + bethington/ghidra-mcp 원클릭 설치 (sudo 필요) |
| `scripts/start-ghidra-mcp.sh` | **[신규]** Xvfb + Ghidra + bridge 서비스 관리 (start/stop/status/restart) |

### 3.7 문서 (4개)

| 파일 | 설명 |
|------|------|
| `docs/re/01_implementation_plan.md` | 구현 계획서 |
| `docs/re/02_work_results_report.md` | 작업 결과 보고서 (본 문서) |
| `docs/re/03_future_development.md` | 추가 개발 필요 내용 |
| `docs/re/04_user_manual.md` | 사용자 메뉴얼 |

---

## 4. 아키텍처 패턴 일관성

기존 DokodemoDoor 패턴과의 일관성을 유지하였다.

| 기존 패턴 | RE 적용 |
|-----------|---------|
| `osv-scanner.mjs` 별도 엔트리 | `re-scanner.mjs` 별도 엔트리 |
| `AGENTS` 객체에 에이전트 등록 | 6개 RE 에이전트 (order 101-106) |
| `PHASES` + `PHASE_ORDER` | `RE_PHASES` + `RE_PHASE_ORDER` |
| `MCP_AGENT_MAPPING` 매핑 | 6개 RE agent → MCP 매핑 |
| `AGENT_VALIDATORS` 검증 | 6개 RE validator (파일 존재 체크) |
| `PHASE_TOOL_REQUIREMENTS` | 모두 `playwright: false` |
| `DeliverableType` enum + 파일명 | 10개 RE deliverable 타입 + 파일명 |
| `save_deliverable` 도구 | 동일 도구, 새 타입명 |
| git checkpoint | 동일 시스템 |
| `runParallelVuln` 병렬 실행 | `runParallelREDynamic` 병렬 실행 |
| `@include()` 프래그먼트 | `_re-scope.txt`, `_re-target.txt` |
| `{{VARIABLE}}` 보간 | `{{BINARY_PATH}}` 등 4개 추가 |

> **참고**: 도구명 `pe_info`는 크로스 플랫폼 지원을 반영하여 `binary_info`로 변경됨.

---

## 5. 데이터 흐름 설계

### observation_candidates.json

정적 분석(re-static) → 동적 관찰(re-dynamic/re-instrument)로 넘어가는 핵심 인터페이스.

```
re-static 에이전트가 Ghidra 분석 결과에서 추출:
- 네트워크 함수 호출점
- 암호화 함수 사용처
- 인증 관련 로직
- 라이선스 검증 루틴

↓ JSON 구조화

re-dynamic / re-instrument 에이전트가 소비:
- ProcMon (Windows) / strace (Linux) 필터 자동 생성
- Frida 훅 포인트 결정
- WinDbg/CDB (Windows) / gdb (Linux) 브레이크포인트 설정
```

---

## 6. 미구현 사항 (의도적 제외)

| 항목 | 상태 | 사유 |
|------|------|------|
| ~~GhidraScript Java 파일 6개~~ | ~~미구현~~ → **해소** | bethington/ghidra-mcp 플러그인 도입으로 대체 |
| ~~re-procmon-mcp~~ | ~~미구현~~ → **완료** | Phase 3에서 구현 (strace 래퍼, 4개 도구) |
| ~~re-windbg-mcp~~ | ~~미구현~~ → **완료** | Phase 3에서 구현 (gdb/MI 래퍼, 7개 도구) |
| ~~re-frida-mcp~~ | ~~미구현~~ → **완료** | Phase 3에서 구현 (frida-node, 7개 도구) |
| ~~re-tshark-mcp~~ | ~~미구현~~ → **완료** | Phase 4에서 구현 (tshark CLI, 6개 도구) |
| E2E 테스트 | 미수행 | 운영 환경(Ubuntu GUI)에서 수행 예정 |

---

## 7. 파일 구조 전체 맵

```
dokodemodoor/
├── re-scanner.mjs                          # [신규] RE CLI 엔트리포인트
├── src/
│   ├── session-manager.js                  # [수정] RE 에이전트 + RE_PHASES 추가
│   ├── constants.js                        # [수정] RE 매핑/검증 추가
│   ├── tool-checker.js                     # [수정] RE 도구 체크 추가
│   ├── ai/
│   │   └── agent-executor.js               # [수정] RE phase 해석 추가
│   ├── phases/
│   │   └── re-analysis.js                  # [신규] RE 오케스트레이터
│   └── prompts/
│       └── prompt-manager.js               # [수정] RE 변수 보간 추가
├── mcp-server/
│   └── src/types/
│       └── deliverables.js                 # [수정] RE deliverable 타입 추가
├── mcp-servers/
│   ├── re-sigcheck-mcp/                    # [신규] Sigcheck/DiE MCP
│   │   ├── package.json
│   │   └── index.js
│   ├── re-ghidra-mcp/                      # [신규→수정] Ghidra MCP
│   │   ├── package.json
│   │   ├── index.js                        # 레거시 (fallback용 보존)
│   │   ├── bridge-wrapper.js               # [Phase2 신규] bethington/ghidra-mcp 래퍼
│   │   └── scripts/
│   │       └── README.md
│   ├── re-procmon-mcp/                     # [Phase3 신규] strace MCP
│   │   ├── package.json
│   │   └── index.js
│   ├── re-windbg-mcp/                      # [Phase3 신규] gdb MCP
│   │   ├── package.json
│   │   └── index.js
│   ├── re-frida-mcp/                       # [Phase3 신규] Frida MCP
│   │   ├── package.json
│   │   └── index.js
│   └── re-tshark-mcp/                      # [Phase4 신규] tshark MCP
│       ├── package.json
│       └── index.js
├── prompts-openai/
│   ├── re-inventory.txt                    # [신규] Pre-Inventory 프롬프트
│   ├── re-static.txt                       # [신규] Static Analysis 프롬프트
│   ├── re-dynamic.txt                      # [Phase3] Dynamic 프롬프트 (완성)
│   ├── re-instrument.txt                   # [Phase3] Instrumentation 프롬프트 (완성)
│   ├── re-network.txt                      # [Phase4] Network 프롬프트 (완성)
│   ├── re-report.txt                       # [신규] Report 프롬프트
│   └── shared/
│       ├── _re-scope.txt                   # [신규] RE 범위/원칙
│       └── _re-target.txt                  # [신규] RE 타겟 정보
├── configs/
│   ├── config-schema.json                  # [수정] reverse_engineering 스키마
│   ├── mcp/
│   │   └── re-tools.json                   # [신규] RE MCP 설정 예시
│   └── profile/
│       └── sample-re.yaml                  # [신규] RE 프로필 예시
├── scripts/
│   ├── setup-ghidra-mcp.sh                # [Phase2 신규] Ghidra MCP 원클릭 설치
│   └── start-ghidra-mcp.sh                # [Phase2 신규] 서비스 관리 (start/stop/status)
└── docs/
    └── re/
        ├── 01_implementation_plan.md       # [신규] 구현 계획서
        ├── 02_work_results_report.md       # [신규] 작업 결과 보고서 (본 문서)
        ├── 03_future_development.md        # [신규] 추가 개발 필요 내용
        └── 04_user_manual.md               # [신규] 사용자 메뉴얼
```
