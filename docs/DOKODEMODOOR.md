# DokodemoDoor: AI Agent Pentest Engine

## 1. 프로그램 개요 (Executive Overview)
DokodemoDoor는 **AI Agent 기반의 자율형 모의침투 플랫폼**이다.

정찰 → 분석 → 검증 → 보고서 작성 → 번역까지 이어지는 **완전한 파이프라인**을 제공하며, 각 단계는 전문 에이전트가 독립적으로 수행한다.

특히 **OpenAI 호환 API(vLLM) 기반으로 재구성**되어, 기존 SDK 의존성을 제거하고 **유연하고 독립적인 실행 구조**를 확보했다.

- **자율형 보안 점검**: 단계별 자동 실행, 실패 복구, 재시도
- **전문가급 보고서**: 검증된 결과만을 포함한 최종 리포트
- **증거 중심**: 코드/런타임 근거 + 도구 기반 검증
- **대규모 보고서 지원**: 자동 분할 번역까지 내장

---

## 2. 전체 아키텍처 개요
### 2.1 시스템 구조
- **Core CLI**: `dokodemodoor.mjs`
- **AI Engine**: OpenAI 호환 vLLM 기반 Provider
- **MCP Tooling**: Playwright/도구 호출 + 저장/작업 관리
- **Audit & Session**: 실행 로그, 결과 검증, 재시도, 세션 복구

### 2.2 주요 모듈
- **Phase Orchestrator**: `checkpoint-manager.js`
- **Session Manager**: `session-manager.js`
- **Prompt Manager**: `prompt-manager.js`
- **LLM Provider**: `ai/providers/vllm-provider.js`
- **Deliverable Save & Validation**: `mcp-server/src/tools/save-deliverable.js`, `queue-validation.js`
- **Report Assembly**: `phases/reporting.js`
- **Translation**: `scripts/translate-report.mjs`

---

## 3. 전체 파이프라인 (Phase 1~5 + 번역)
### Phase 1: Pre-Reconnaissance
- 네트워크 스캔 + 코드 분석
- 산출물:
  - `code_analysis_deliverable.md`
  - `pre_recon_deliverable.md`

### Phase 2: Reconnaissance
- Playwright 기반 동적 탐색 + API/권한 구조 도식화
- 산출물:
  - `recon_deliverable.md`

### Phase 3: Vulnerability Analysis (8개 병렬 전문 에이전트)
- SQLi, CodeI, SSTI, PathI, XSS, Auth, AuthZ, SSRF
- 산출물:
  - `*_analysis_deliverable.md`
  - `*_exploitation_queue.json`

### Phase 4: Exploitation (8개 병렬 전문 에이전트)
- Queue 기반 증명형 공격 수행
- 산출물:
  - `*_exploitation_evidence.md`

### Phase 5: Reporting
- 전문 요약 + 전체 보고서 통합
- 산출물:
  - `comprehensive_security_assessment_report.md`

### (선택) Phase 6: Reporting Translation(KR)
- 대형 보고서를 **자동 분할 번역** 후 합성
- 산출물:
  - `comprehensive_security_assessment_report_kr.md`

---

## 4. 정량적 규모 (Quantitative Facts)
- **총 에이전트 수: 19**
  - Phase 1: 1
  - Phase 2: 1
  - Phase 3: 8
  - Phase 4: 8
  - Phase 5: 1
- **동시 실행 가능 에이전트**: vuln/exploit phases 병렬 처리
- **결과 저장 파일 수**: 최소 1 → 최대 20+ (분석 + 큐 + 증거 + 최종 보고서)

---

## 5. 프롬프트 엔진 (Prompt System)
### 5.1 철학
- **전문가 역할 기반**: 각 에이전트가 특정 보안 도메인에 특화
- **증거 기반 규칙**: 코드/런타임 경로 + 파일/라인 단위 근거 요구
- **실행 규칙 강제**: TodoWrite, save_deliverable 의무화

### 5.2 통일성 보장 사항
- 모든 Phase에서 **config rules (focus/avoid)** 및 **login instructions** 반영
- 모든 분석/증거 큐는 **표준 JSON 스키마**로 통일
- Exploitation 프롬프트의 템플릿 파싱 오류 해결 (Handlebars 제거)

---

## 6. 자동화 품질 메커니즘
### 6.1 Validation Layer
- 분석 결과와 queue 파일의 존재 및 구조 검증
- Queue JSON은 `{ "vulnerabilities": [...] }` 구조 강제

### 6.2 Retry & Recovery
- Agent 실패 시 최대 3회 재시도
- 세션 상태 자동 복구 / 재개 기능 포함

### 6.3 Audit Logging
- 모든 턴, tool call, 에러 기록
- 실행 단계별 비용/시간 기록

### 6.4 Login Automation & Verification (범용)
DokodemoDoor는 **config-driven 로그인 자동화**를 제공하며, 특정 사이트 하드코딩 없이도 **자연어 기반 플로우**로 로그인 절차를 수행한다.

Recon 단계 시작 전에 **Login Check Agent**가 사전 검증을 실행하여, 인증 실패를 조기에 차단한다.

자동 로그인 플로우 (범용 단계)
1. `login_url`로 이동 (Playwright)
2. `login_flow`의 문장 지시를 순차 실행
   - `$username`, `$password`, `$totp` 자동 치환
   - “있다면/optional” 단계는 요소 존재 확인 후 조건부 수행
3. 배너/팝업/쿠키 동의 자동 닫기
4. 성공 판정:
   - `success_condition` 기반 확인 (url_contains / url_equals_exactly / element_present)
   - **success_condition이 없으면 자동 휴리스틱**
     (로그인 페이지 이탈 + 로그아웃/계정 메뉴/아바타/토큰 존재)
5. 실패 시 1회 재시도 + 대기
6. 성공/실패 시 **스크린샷 증거 자동 저장** (`deliverables/login-check/`)
7. 실패 시 **DOM 스냅샷 저장** 및 **인증 지표 로그(쿠키/스토리지 키 이름만)** 기록

- **하드코딩 없음**: 로그인 플로우는 문장/인스트럭션으로 주어지며, 어떤 대상에도 적용 가능
- **검증 선행**: Recon 이전에 인증 성공 여부를 확실히 확인
- **증거 기반**: 실패 상황도 스크린샷으로 남겨 재현/디버깅 가능

---

## 7. 성능 및 안정성
- **Parallel Execution**: vuln/exploit 단계 5배 이상 병렬 효율
- **Staggered Calls**: API overload 방지 (2초 간격)
- **Git 기반 checkpoint**: 단계 완료 시 즉시 커밋
- **Race 조건 개선**: 병렬 실행 시 커밋 해시 일치성 보장

---

## 8. 보안/운영 안전장치
- **Scope 제한 강제**: 외부 네트워크 접근만 허용
- **Exploit 단계 규정 강화**: 반드시 증거가 있어야 EXPLOITED 판정
- **False Positive 기록 체계**: 실패는 기록하되 보고서는 정제

---

## 9. 번역기(Translator) 특징
- **대형 보고서 자동 분할**
- **Markdown 유지 규칙** (헤더, 표, 코드블록 불변)
- **전문 용어와 문맥을 반영한 초월 번역**(단순 번역기능으로는 보안 카테고리 특성 상 한계가 있음)
- **LLM 선택 가능** (로컬 LLM / OpenAI 등)

---

## 10. 기능적 강점 요약
- ✅ **정찰 → 분석 → 검증 → 보고서 → 번역까지 전체 펜테스트 주기 자동화**
- ✅ **전문 Agent 분업 구조**
- ✅ **증거 기반 결론 (Proof-based)**
- ✅ **자동 세션 복구 + 실패 재시도**
- ✅ **정량적 로깅 (비용/시간)**
- ✅ **OpenAI 호환 vLLM 환경 독립성**
- ✅ **고품질의 보고서 생성**

---

## 11. 향후 확장 방향 (Optional Roadmap)
- 실시간 대시보드/시각화
- 산업별 템플릿 (금융/의료/정부)
- “계정 수집/역할 자동 테스트” 고도화
- CVSS 자동 계산 및 위험 점수화
- 결과에 대한 증명 캡처 자동 첨부
- 다양한 MCP 툴 연계(Burp, BlackDuck, Ghidra 등)

---

# 최종 결론
DokodemoDoor는 **AI 기반 자율형 모의침투의 “풀스택 파이프라인”**으로,
**정찰부터 번역까지 하나의 흐름에서 완결되는 설계**를 구현했다.
특히 **증거 기반 판단**, **전문가급 프롬프트 설계**, **대규모 보고서 번역 지원**이라는 차별점은 대회 제출 기준에서도 강력한 경쟁력을 제공한다.
