# 20260214 Vulnerability-Analysis Prompt 심층 분석 보고서

작성일: 2026-02-14  
분석 기준 시점: 2026-02-14 코드베이스 (`prompts-openai/`, `src/`, `mcp-server/src/`)

## 1. 전체 흐름/정렬 분석 (vuln 단계 중심)

### 1.1 파이프라인 상 위치와 순서 정렬
현재 실행 순서는 `pre-reconnaissance -> reconnaissance -> api-fuzzing -> vulnerability-analysis -> exploitation -> reporting` 이며, vuln 8개는 독립 phase로 명시되어 있다.

근거:
- `src/session-manager.js:271`
- `src/session-manager.js:276`

### 1.2 vuln 8개 실행 정렬
vuln 단계는 병렬 실행이며, semaphore 기반 동시성 제어(`parallelLimit`)를 사용한다.

근거:
- `src/checkpoint-manager.js:882`
- `src/checkpoint-manager.js:893`
- `src/checkpoint-manager.js:896`

### 1.3 에이전트-프롬프트 매핑 정렬
`{type}-vuln` -> `vuln-{type}` 매핑은 8개 카테고리 모두 일관되게 정의되어 있다.

근거:
- `src/checkpoint-manager.js:1833`
- `src/checkpoint-manager.js:1840`

### 1.4 산출물 계약(analysis + queue) 정렬
vuln 각 프롬프트는 분석 리포트와 queue JSON 2개 저장을 강제하며, 런타임도 해당 파일 존재 여부를 검증한다.

근거:
- `prompts-openai/vuln-sqli.txt:291`
- `prompts-openai/vuln-auth.txt:73`
- `src/queue-validation.js:49`
- `src/queue-validation.js:56`
- `src/queue-validation.js:61`

### 1.5 exploit 연계 정렬
vuln 완료 후 queue의 `vulnerabilities.length > 0`일 때만 exploit 대상으로 활성화된다.

근거:
- `src/queue-validation.js:359`
- `src/queue-validation.js:364`

요약: phase ordering과 계약 구조는 전반적으로 잘 맞춰져 있다.

## 2. vuln 프롬프트 공통 구조 분석

### 2.1 공통 include 체인
vuln 8개는 공통적으로 다음 shared 규칙을 포함한다.
- `_vuln-scope` (외부공격자 범위, 멀티소스 인텔, 누적분석)
- `_analysis-efficiency-limits` (탐색/검색 상한)
- `_analysis-stop-rules` (조기 종료/저장 규칙)
- `_json-hygiene`, `_cvss-scoring`

근거:
- `prompts-openai/vuln-sqli.txt:35`
- `prompts-openai/vuln-sqli.txt:187`
- `prompts-openai/vuln-sqli.txt:188`
- `prompts-openai/vuln-sqli.txt:346`
- `prompts-openai/vuln-sqli.txt:364`

### 2.2 입력 인텔 소스 정렬
각 vuln 프롬프트는 `recon_verify -> api_fuzzer -> recon` 순의 카테고리별 고신뢰 타깃 우선 분석을 지시한다.

근거:
- `prompts-openai/vuln-sqli.txt:109`
- `prompts-openai/vuln-sqli.txt:110`
- `prompts-openai/vuln-sqli.txt:111`
- `prompts-openai/shared/_vuln-scope.txt:10`

### 2.3 큐 스키마 표준화 수준
모든 큐는 `{"vulnerabilities": [...]}` 형태를 공유하고 severity(`Critical|High|Medium|Low`)를 포함한다. 다만 카테고리별 필드 편차가 크다.

근거:
- `prompts-openai/vuln-sqli.txt:323`
- `prompts-openai/vuln-auth.txt:345`
- `prompts-openai/vuln-authz.txt:341`
- `mcp-server/src/validation/queue-validator.js:186`
- `mcp-server/src/validation/queue-validator.js:201`

## 3. vuln 8개 개별 심층 분석

### 3.1 `vuln-sqli.txt` (374 lines)
강점:
- slot 기반 분류(`SQL-val`, `SQL-like`, `SQL-ident`)가 exploit 단계 전달에 유리.
- analysis 단계에서 live exploitation 금지 규칙이 명확.

근거:
- `prompts-openai/vuln-sqli.txt:333`
- `prompts-openai/vuln-sqli.txt:192`

리스크:
- 완료 조건에 `Recon 9` 문구가 남아 있어 현재 todo baseline과 의미 정합성이 약함.

근거:
- `prompts-openai/vuln-sqli.txt:369`

### 3.2 `vuln-codei.txt` (384 lines)
강점:
- 고위험 실행 sink 전수 커버리지 요구가 강함.
- 실행 컨텍스트 필드(`execution_context`) 제공으로 exploit 준비도 높음.

근거:
- `prompts-openai/vuln-codei.txt:128`
- `prompts-openai/vuln-codei.txt:341`

리스크:
- 공통 stop-rule의 조기 종료(High/Critical 발견 시)와 전수 커버리지 지시가 긴장 관계를 형성.

근거:
- `prompts-openai/vuln-codei.txt:128`
- `prompts-openai/shared/_analysis-stop-rules.txt:4`

### 3.3 `vuln-ssti.txt` (360 lines)
강점:
- `template_engine`, `render_call`, `engine_class` 등 exploit 연계에 필요한 핵심 필드를 갖춤.
- live exploitation 금지 규칙이 명확.

근거:
- `prompts-openai/vuln-ssti.txt:318`
- `prompts-openai/vuln-ssti.txt:319`
- `prompts-openai/vuln-ssti.txt:320`
- `prompts-openai/vuln-ssti.txt:195`

리스크:
- file/search/miss cap이 엄격하여 대형 코드베이스에서는 under-coverage 가능성.

근거:
- `prompts-openai/vuln-ssti.txt:200`
- `prompts-openai/vuln-ssti.txt:205`
- `prompts-openai/vuln-ssti.txt:207`

### 3.4 `vuln-pathi.txt` (398 lines)
강점:
- Path/LFI/RFI/ZIPSlip/TarSlip/TempFile까지 커버하는 큐 타입 구성이 실전적.

근거:
- `prompts-openai/vuln-pathi.txt:350`

리스크:
- SQLI/CODEI/SSTI와 달리 explicit "No Live Exploitation" 문구가 없어 분석-익스플로잇 경계가 상대적으로 약함.

근거:
- `prompts-openai/vuln-pathi.txt:160`
- 비교 기준: `prompts-openai/vuln-sqli.txt:192`, `prompts-openai/vuln-codei.txt:208`, `prompts-openai/vuln-ssti.txt:195`

### 3.5 `vuln-xss.txt` (369 lines)
강점:
- `render_context`, `encoding_observed`, `mismatch_reason`는 exploit payload 설계에 직접 유효.

근거:
- `prompts-openai/vuln-xss.txt:329`
- `prompts-openai/vuln-xss.txt:330`
- `prompts-openai/vuln-xss.txt:332`

리스크:
- exploit-xss가 참조하는 큐 필드명(`source_detail`)과 vuln-xss 산출 필드명(`source`) 불일치.

근거:
- `prompts-openai/vuln-xss.txt:326`
- `prompts-openai/exploit-xss.txt:246`

### 3.6 `vuln-auth.txt` (391 lines)
강점:
- exploit-auth가 즉시 활용 가능한 필드(`source_endpoint`, `vulnerable_code_location`, `suggested_exploit_technique`)를 제공.

근거:
- `prompts-openai/vuln-auth.txt:352`
- `prompts-openai/vuln-auth.txt:353`
- `prompts-openai/vuln-auth.txt:356`

리스크:
- Inclusion rule 문구 오타(`**Inclusion Rule:**:`)가 존재.

근거:
- `prompts-openai/vuln-auth.txt:364`

### 3.7 `vuln-ssrf.txt` (357 lines)
강점:
- exploit 단계 지시와 연결되는 `suggested_exploit_technique` 필드가 명확.

근거:
- `prompts-openai/vuln-ssrf.txt:321`

리스크:
- 공통 OOB 정책은 `{{EXTERNAL_TEST_DOMAIN}}`만 허용인데, 예시는 `callback.example.com` 사용으로 정책 충돌 가능.

근거:
- `prompts-openai/shared/_vuln-scope.txt:26`
- `prompts-openai/shared/_vuln-scope.txt:28`
- `prompts-openai/vuln-ssrf.txt:178`

### 3.8 `vuln-authz.txt` (390 lines)
강점:
- `role_context`, `guard_evidence`, `minimal_witness` 필드가 exploit-authz 재현성에 유리.

근거:
- `prompts-openai/vuln-authz.txt:350`
- `prompts-openai/vuln-authz.txt:351`
- `prompts-openai/vuln-authz.txt:354`

리스크:
- 조기 보고 규칙(3개 High/Critical 시 stop)과 파일 상한(10+3)이 함께 작동하면 범위 누락 가능.

근거:
- `prompts-openai/vuln-authz.txt:182`
- `prompts-openai/vuln-authz.txt:226`
- `prompts-openai/vuln-authz.txt:229`

## 4. 교차 이슈 (우선순위)

### [Critical-1] 큐 validator가 카테고리 필수 필드를 강제하지 않음
현 validator는 사실상 `vulnerabilities[]` 존재 + severity만 강제한다. exploit 프롬프트들은 `suggested_exploit_technique`, `minimal_witness`, `render_context` 등 특정 필드를 전제로 동작한다.

근거:
- `mcp-server/src/validation/queue-validator.js:186`
- `mcp-server/src/validation/queue-validator.js:201`
- `prompts-openai/exploit-auth.txt:270`
- `prompts-openai/exploit-ssrf.txt:235`
- `prompts-openai/exploit-authz.txt:270`
- `prompts-openai/exploit-xss.txt:246`

영향:
- queue 저장은 성공해도 exploit 단계 품질/재현성이 급격히 저하될 수 있음.

### [Critical-2] XSS vuln->exploit 필드명 계약 불일치
vuln-xss는 `source`, exploit-xss는 `source_detail`을 기대한다.

근거:
- `prompts-openai/vuln-xss.txt:326`
- `prompts-openai/exploit-xss.txt:246`

영향:
- exploit-xss 초기 payload 설계에서 queue intelligence 일부를 놓칠 수 있음.

### [High-3] queue dedup 키가 케이스별로 과도 축약되어 데이터 손실 가능
현재 dedup 키는 `vulnerability_type + (source/source_endpoint/endpoint/...)` 기반이다. 같은 endpoint에 서로 다른 증거(역할/파라미터/사이드이펙트)가 있어도 합쳐질 수 있다.

근거:
- `mcp-server/src/tools/save-deliverable.js:124`
- `mcp-server/src/tools/save-deliverable.js:136`
- `prompts-openai/shared/_vuln-scope.txt:20`

영향:
- 누적 분석/재실행 시 distinct finding이 queue merge에서 탈락할 가능성.

### [High-4] vuln 병렬 실행 + Playwright 서버 편중
vuln 8개는 병렬 실행되지만, `sqli/codei/ssti/pathi` 4개가 동일 MCP 서버(`playwright-agent1`)를 공유한다.

근거:
- `src/checkpoint-manager.js:882`
- `src/checkpoint-manager.js:896`
- `src/constants.js:107`
- `src/constants.js:110`

영향:
- 브라우저 세션/네트워크 로그 교차 오염 및 재현성 저하 위험.

### [Medium-5] 누적 분석 파일 트래킹이 일부 카테고리에서 비어버림
`cumulative-analysis`는 queue의 `path` 필드만 수집한다. 그러나 auth/authz/ssrf 큐 스키마에는 `path`가 없다.

근거:
- `src/utils/cumulative-analysis.js:117`
- `src/utils/cumulative-analysis.js:118`
- `prompts-openai/vuln-auth.txt:352`
- `prompts-openai/vuln-authz.txt:348`
- `prompts-openai/vuln-ssrf.txt:316`

영향:
- 누적분석 모드에서 분석된 파일 히스토리가 카테고리별로 불균형하게 축적됨.

### [Medium-6] 완료 조건 문구의 잔존 레거시 (`Recon 9`)
여러 vuln 프롬프트 완료 조건에 현재 문맥과 맞지 않는 `Recon 9` 문구가 남아 있다.

근거:
- `prompts-openai/vuln-sqli.txt:369`
- `prompts-openai/vuln-codei.txt:375`
- `prompts-openai/vuln-ssti.txt:355`
- `prompts-openai/vuln-pathi.txt:393`
- `prompts-openai/vuln-xss.txt:364`
- `prompts-openai/vuln-ssrf.txt:352`

### [Medium-7] 분석 단계의 "live exploit 금지" 정책이 카테고리별로 불균질
sqli/codei/ssti는 명시적 금지, pathi/ssrf/auth 등은 실동작 Playwright 시나리오를 제시해 단계 경계가 약함.

근거:
- `prompts-openai/vuln-sqli.txt:192`
- `prompts-openai/vuln-codei.txt:208`
- `prompts-openai/vuln-ssti.txt:195`
- `prompts-openai/vuln-pathi.txt:160`
- `prompts-openai/vuln-ssrf.txt:160`
- `prompts-openai/vuln-auth.txt:150`

## 5. 개선 권고안

### P0 (즉시)
1. 카테고리별 queue JSON 필수 필드 검증 도입
- 예: AUTH는 `source_endpoint`, `suggested_exploit_technique` 필수, XSS는 `render_context`, `mismatch_reason` 필수.

2. XSS 필드명 계약 단일화
- `source` 또는 `source_detail` 중 하나로 vuln/exploit 양쪽을 통일.

3. dedup 키 고도화
- 최소 구성: `vulnerability_type + endpoint/source + parameter(or vulnerable_parameter) + role_context(optional)`.

### P1 (단기)
1. vuln MCP 매핑 분산
- `vuln-sqli/codei/ssti/pathi`를 분산 매핑하여 병렬 오염 리스크 완화.

2. OOB 예시 정책 정합화
- 모든 예시 URL을 `{{EXTERNAL_TEST_DOMAIN}}` 기반으로 통일.

3. 완료 조건 레거시 문구 제거
- `Recon 9`를 현재 baseline todo 기준으로 교체.

### P2 (중기)
1. Prompt-Contract Lint 도입
- vuln queue schema와 exploit 참조 필드명 불일치 자동 검출.

2. cumulative-analysis 보강
- `path`가 없을 경우 `vulnerable_code_location` 등을 fallback으로 분석 파일 추출.

## 6. 결론
vuln 8개 프롬프트는 카테고리 특화도와 산출물 구조는 상당히 성숙했다. 다만 운영 신뢰도를 떨어뜨리는 핵심은 **(1) 큐 필수 필드 무검증, (2) XSS 필드명 계약 불일치, (3) merge dedup 키 과축약**이다. 개선 우선순위는 P0 3개 항목을 먼저 처리한 뒤, 병렬 실행 안정화(P1)로 넘어가는 것이 가장 효과적이다.

## 7. 개선 적용 현황 (2026-02-14)

### 적용 완료(또는 실질 적용)
- P0-2 XSS 필드명 계약 단일화: exploit-xss가 참조하는 필드명을 `source`로 정리하여 vuln/exploit 계약 불일치 해소. (`prompts-openai/exploit-xss.txt`, `prompts-openai/vuln-xss.txt`)
- P0-3 dedup 키 고도화: 큐 merge dedup 키에 endpoint/source fallback + param/role discriminator 추가. (`mcp-server/src/tools/save-deliverable.js`)
- P1-1 vuln MCP 매핑 분산: vuln 8개를 Playwright 인스턴스별로 분산 매핑. (`src/constants.js`)
- P1-2 OOB 예시 정책 정합화: SSRF 예시/지시를 `{{EXTERNAL_TEST_DOMAIN}}` 기반으로 정리. (`prompts-openai/vuln-ssrf.txt`, `prompts-openai/shared/_vuln-scope.txt`)
- P1-3 완료 조건 레거시 문구 제거: `Recon 9` 등 레거시 완료 조건 문구 제거. (`prompts-openai/vuln-*.txt`)
- P2-2 cumulative-analysis 보강: `path` 미존재 카테고리에서도 fallback 필드로 analyzed file 추출. (`src/utils/cumulative-analysis.js`)

### 부분 적용(Warning 레벨)
- P0-1 카테고리별 queue 필수 필드 검증: 저장을 막지는 않지만, 누락 시 warning으로 감지/로그 출력. (`mcp-server/src/validation/queue-validator.js`, `mcp-server/src/tools/save-deliverable.js`)

### 미적용(추가 작업 필요)
- P2-1 Prompt-Contract Lint(필드 계약 불일치 자동 검출): `prompt-lint` 기반은 도입했지만, vuln queue schema와 exploit 참조 필드명 불일치까지 정적 검증하는 규칙은 추가 설계가 필요.
