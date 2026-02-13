# Reverse Engineering Phase 추가 개발 필요 내용

> 작성일: 2026-02-13
> 최종 수정: 2026-02-13
> 기준: Phase 4 네트워크 분석 완성 시점 (전 Phase 코드 구현 완료)

---

## 1. ~~GhidraScript 브릿지 구현~~ → ✅ 완료 (bethington/ghidra-mcp 도입)

> **해소됨**: [bethington/ghidra-mcp](https://github.com/bethington/ghidra-mcp) 플러그인을 도입하여 110개 도구를 확보. 자체 GhidraScript 6개를 구현할 필요가 없어짐.

### 도입 내역

| 항목 | 내용 |
|------|------|
| 플러그인 | bethington/ghidra-mcp v2.0.0 (Ghidra 12.0.2 호환) |
| 아키텍처 | 옵션 C: Xvfb + Ghidra GUI Plugin (운영 환경: 네이티브 Ubuntu GUI) |
| 도구 수 | 110개 (기존 7개 → 15배 증가) |
| 래퍼 | `mcp-servers/re-ghidra-mcp/bridge-wrapper.js` (stdio MCP ↔ Python bridge) |
| 서비스 관리 | `scripts/setup-ghidra-mcp.sh`, `scripts/start-ghidra-mcp.sh` |
| 프롬프트 | `re-static.txt` 확장 (콜그래프, 배치 연산, 리네이밍/문서화 단계 추가) |

### 남은 작업

- **E2E 테스트**: 운영 환경(Ubuntu GUI)에서 Ghidra 플러그인 로드 → 바이너리 분석 → deliverable 생성 전체 흐름 검증
- **Ghidra 자동 기동 최적화**: 플러그인 MCP Server 자동 시작 설정 (수동 `Tools > GhidraMCP > Start` 없이)
- **프롬프트 튜닝**: 110개 도구 중 re-static 에이전트의 최적 도구 호출 전략 실험적 검증

---

## 2. ~~동적 분석 MCP 서버~~ → ✅ 완료

Phase 3 `re-dynamic-observation` 에이전트들이 사용하는 MCP 서버 2개 구현 완료.

### 2.1 re-procmon-mcp — ProcMon (Windows) / strace (Linux)

크로스 플랫폼 프로세스 트레이싱 MCP 서버. Windows에서는 ProcMon CLI(`Procmon64.exe`), Linux에서는 `strace`를 래핑한다.

| 도구 | 설명 | 구현 방법 (Windows) | 구현 방법 (Linux) |
|------|------|---------------------|-------------------|
| `procmon_start_capture` | 필터 포함 캡처 시작 | `/AcceptEula /Minimized /Quiet /BackingFile` | `strace -f -e trace=... -o` |
| `procmon_stop_capture` | 캡처 중지 + CSV 내보내기 | `/Terminate` + CSV 변환 | SIGINT + 로그 파싱 |
| `procmon_get_events` | CSV/XML 파싱 이벤트 조회 | CSV 파서 + 필터링 | strace 출력 파싱 |
| `procmon_set_filter` | 필터 설정 | PMC 필터 파일 생성 | strace `-e` 필터 구성 |

**난이도**: 중간
- **Windows**: ProcMon CLI 모드는 `/BackingFile`, `/Minimized`, `/Terminate` 등 제한적 옵션 제공. 필터 설정은 PMC(ProcMon Configuration) 파일을 프로그래밍적으로 생성해야 함.
- **Linux**: strace의 `-e trace=` 옵션으로 syscall 필터링. 출력 파싱은 비교적 간단.

### 2.2 re-windbg-mcp — WinDbg/CDB (Windows) / gdb (Linux)

크로스 플랫폼 디버거 MCP 서버. Windows에서는 CDB(Console Debugger), Linux에서는 gdb를 래핑한다.

| 도구 | 설명 | Windows (CDB) | Linux (gdb) |
|------|------|---------------|-------------|
| `cdb_attach_process` | PID/이름으로 프로세스 연결 | `cdb -p <pid>` | `gdb -p <pid>` |
| `cdb_run_command` | 디버거 명령 실행 | **대화형 세션 관리** | gdb/MI 인터페이스 |
| `cdb_set_breakpoint` | 브레이크포인트 설정 | `bp`/`bu` 명령 | `break` 명령 |
| `cdb_list_modules` | 로드된 모듈 목록 | `lm` 출력 파싱 | `info sharedlibrary` 파싱 |
| `cdb_list_threads` | 스레드 + 스택 | `~*k` 출력 파싱 | `info threads` + `bt` 파싱 |
| `cdb_list_exceptions` | 예외 이벤트 | 자동 로깅 | signal handler 로깅 |
| `cdb_capture_crash` | 크래시 덤프 | `.dump /ma` 명령 | `generate-core-file` 명령 |

**난이도**: 높음
- CDB/gdb 모두 대화형(interactive) 도구 — stdin/stdout 세션을 지속적으로 관리해야 함
- 명령 전송 → 결과 대기 → 파싱의 비동기 흐름 구현 필요
- 브레이크포인트 히트 시 콜백/이벤트 처리
- 프로세스 크래시/종료 시 정리(cleanup) 로직
- **Linux**: gdb/MI(Machine Interface)를 활용하면 구조화된 출력 처리 가능

---

## 3. ~~런타임 계측 MCP 서버~~ → ✅ 완료

### 3.1 re-frida-mcp

Frida의 Node.js 바인딩(`frida-node`)을 활용한 MCP 서버. **구현 완료.**

| 도구 | 설명 |
|------|------|
| `frida_attach` | 프로세스 PID/이름으로 연결 |
| `frida_hook_function` | 함수 훅 설치 (entry args, return value 로깅) |
| `frida_list_modules` | 로드된 모듈 목록 |
| `frida_list_exports` | 특정 모듈의 export 함수 |
| `frida_inject_script` | 커스텀 JavaScript 스크립트 삽입 |
| `frida_get_logs` | 수집된 훅 로그 조회 |
| `frida_unhook` | 설치된 훅 제거 |

**핵심 구현 과제**:
- `observation_candidates.json`에서 자동으로 Frida 스크립트 생성
- 훅 로그를 구조화된 JSON으로 수집 (타임스탬프, 인자, 반환값, 콜스택)
- `frida-node` 패키지의 네이티브 빌드 (Windows/Linux 환경)
- 안티 디버깅/안티 프리다 우회 전략

**난이도**: 중간
- `frida-node` API는 비교적 잘 문서화되어 있음
- 훅 스크립트 자동 생성이 핵심 부가가치

---

## ~~4. 네트워크 분석 MCP 서버~~ → ✅ 완료

### 4.1 re-tshark-mcp

tshark CLI를 래핑하는 MCP 서버. **구현 완료.**

| 도구 | 설명 |
|------|------|
| `tshark_start_capture` | 인터페이스/BPF 필터/시간·패킷 제한 캡처 시작 |
| `tshark_stop_capture` | 캡처 중지 + PCAP 통계 요약 |
| `tshark_analyze_capture` | PCAP 분석 (summary/protocols/endpoints/conversations/expert) |
| `tshark_get_http_streams` | HTTP 요청/응답 스트림 추출 (호스트 필터) |
| `tshark_get_dns_queries` | DNS 쿼리/응답 추출 + 도메인 집계 |
| `tshark_get_tls_handshakes` | TLS Client Hello 추출 (SNI, 버전, 암호 스위트) |

**핵심 구현 특징**:
- BPF 필터 기반 정밀 캡처 (노이즈 최소화)
- tshark `-T fields` 출력 파싱 (JSON보다 빠르고 필드별 추출 용이)
- 세션 관리: 캡처 프로세스 라이프사이클, 자동 타임아웃
- 다중 분석 모드: summary, protocols, endpoints, conversations, expert

---

## 5. 프롬프트 고도화 (우선순위: 중간)

### ~~5.1 스켈레톤 프롬프트 완성~~ → ✅ 완료

3개 스켈레톤 프롬프트를 MCP 서버 구현에 맞춰 완성:

| 프롬프트 | 연동 MCP | 핵심 기능 | 상태 |
|----------|----------|-----------|------|
| `re-dynamic.txt` | re-procmon + re-windbg | strace 필터 자동 생성, 다회 캡처, gdb 디버거 관찰, 행위 로깅 | ✅ 완료 |
| `re-instrument.txt` | re-frida | observation_candidates 기반 자동 훅, 로그 수집, 커스텀 스크립트 | ✅ 완료 |
| `re-network.txt` | re-tshark | 캡처 전략, 다회 캡처, 6개 분석 단계, 보안 판단, 교차 검증 | ✅ 완료 |

### 5.2 기존 프롬프트 개선

- `re-inventory.txt`: .NET/Java 바이너리 분기 로직 강화
- ~~`re-static.txt`: Ghidra 도구 호출 전략 최적화~~ → ✅ 완료 (110개 도구 활용, 콜그래프/배치/리네이밍 단계 추가)
- `re-report.txt`: 동적/네트워크 분석 결과 통합 템플릿

### 5.3 신규 공유 프래그먼트

| 프래그먼트 | 용도 |
|------------|------|
| `_re-observation-format.txt` | observation_candidates.json 스키마 명세 (프롬프트에서 참조) |
| `_re-evidence-rules.txt` | 증적 수집 규칙 (스크린샷 대신 로그/JSON 기반) |

---

## 6. 인프라 개선 (우선순위: 낮음~중간)

### 6.1 RE 전용 테스트 프레임워크

- 알려진 PE/ELF 바이너리(예: putty.exe, notepad++.exe, /usr/bin/curl, /usr/bin/wget)를 테스트 타겟으로 활용
- MCP 서버 단위 테스트: 각 도구의 입출력 검증
- E2E 테스트: `re-scanner.mjs` → 전체 파이프라인 실행 → deliverables 확인

### 6.2 RE 세션 관리 개선

- 웹 세션과 RE 세션의 명시적 구분 (세션 타입 필드 추가)
- RE 세션 상태 시각화 (status.sh 연동)
- 이전 RE 분석 결과 재활용 (누적 분석 패턴)

### 6.3 설정 스키마 확장

- MCP 서버 자동 감지 (설치된 도구 기반)
- 도구별 버전 요구사항 명시
- 분석 프리셋 (quick/standard/deep)

### 6.4 병렬 실행 확장

현재 Phase 3만 병렬 실행. 향후:
- Phase 3 + Phase 4 동시 시작 가능성 검토 (네트워크 캡처는 동적 분석과 동시에)
- 병렬 한도(`DOKODEMODOOR_PARALLEL_LIMIT`) RE 파이프라인 적용

---

## 7. 고급 기능 (우선순위: 낮음)

### 7.1 멀티 바이너리 분석

- 하나의 프로세스가 여러 DLL/실행파일을 포함하는 경우
- 메인 바이너리 + 하위 DLL 연쇄 분석
- `re-inventory` 단계에서 의존성 그래프 생성

### 7.2 .NET / Java 바이너리 지원

- .NET: dnSpy CLI 또는 ILSpy CLI 기반 MCP 서버
- Java: jadx CLI 기반 MCP 서버
- `re-inventory`에서 런타임 판별 후 자동 분기

### 7.3 macOS 바이너리 지원

> **참고**: ELF (Linux) 바이너리는 MVP에서 이미 기본 지원됨 (`file`+`readelf` 기반 인벤토리, Ghidra 정적 분석).

- Mach-O 파일 지원 확장
- `otool` / `codesign` 기반 인벤토리
- Ghidra는 멀티 플랫폼 지원하므로 정적 분석은 호환
- 동적 분석: `dtrace`/`lldb` 기반 MCP 서버

### 7.4 AI 분석 전략 자동화

- 인벤토리 결과 기반 분석 전략 자동 결정
- 패킹 탐지 → 자동 언패킹 시도
- 컴파일러 식별 → 최적 분석 도구 선택
- 이전 분석 결과 학습 → 프롬프트 자동 조정

### 7.5 보고서 고도화

- 웹 펜테스트 보고서와 통합 (하이브리드 평가)
- MITRE ATT&CK 매핑
- CVE/취약점 데이터베이스 자동 연동
- 시각화 (호출 그래프, 데이터 플로우 다이어그램)

---

## 8. 개발 우선순위 로드맵

```
Phase 2: Ghidra 완성 ─────────────────────────── ✅ 완료
│ ✅ bethington/ghidra-mcp 도입 (110개 도구)
│ ✅ bridge-wrapper.js + 서비스 스크립트
│ ✅ re-static.txt 프롬프트 확장
│ ⏳ E2E 테스트 (운영 환경에서 수행 예정)
│
Phase 3: 동적 분석 ──────────────────────────── ✅ 완료
│ ✅ re-procmon-mcp (strace 래퍼, 4개 도구)
│ ✅ re-windbg-mcp (gdb/MI 래퍼, 7개 도구)
│ ✅ re-frida-mcp (frida-node, 7개 도구)
│ ✅ re-dynamic.txt / re-instrument.txt 프롬프트 완성
│ ⏳ E2E 테스트 (운영 환경에서 수행 예정)
│
Phase 4: 네트워크 분석 ─────────────────────────── ✅ 완료
│ ✅ re-tshark-mcp (tshark CLI 래퍼, 6개 도구)
│ ✅ re-network.txt 프롬프트 완성
│ ⏳ E2E 테스트 (운영 환경에서 수행 예정)
│
Phase 5: 고도화 ──────────────────────────────── (우선순위 낮음)
  .NET/Java 바이너리 지원
  멀티 바이너리 분석 (bethington/ghidra-mcp 크로스바이너리 문서 전파 활용)
  macOS (Mach-O) 바이너리 지원
  AI 전략 자동화
  보고서 시각화
```
