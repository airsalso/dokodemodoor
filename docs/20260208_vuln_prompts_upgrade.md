아래는 **화이트박스 웹앱 펜테스트 AI 분석** 관점에서, **8개 vuln 프롬프트 + include/shared 프롬프트**를 모두 다시 리뷰한 결과입니다. 각 항목마다 강점, 리스크, 개선 제안을 분리했습니다. 범용 웹 애플리케이션을 대상으로 했다는 전제를 유지했습니다.

**공통 include 프롬프트 리뷰**

**1) `prompts-openai/shared/_anti-redundancy.txt`**
- 강점  
카테고리 분리를 강하게 강제해 보고서 중복과 범람을 억제함.
- 리스크  
“ZERO TOLERANCE FOR OVERLAP”이 지나치게 엄격해 복합 취약점 경로를 언급할 수 없게 만듦. 예: AuthZ 우회가 SQLi 기반일 때 AuthZ에서 배제되면 설명 누락.
- 개선 제안  
“보고서는 카테고리 내 결론만, 교차 원인은 맥락 1–2줄 허용” 같은 안전한 완화 문구 추가. 특히 AuthZ/AuthN, SSTI/CODEI, PATHI/SSRF 경계에서 예외 허용 필요.

**2) `prompts-openai/shared/_analysis-efficiency-limits.txt`**
- 강점  
루프 방지, 반복 검색 억제, 정지 규칙이 명확함.
- 리스크  
“RECON-TRUST”가 지나치게 강하면 recon 품질이 낮을 때 오탐을 그대로 추적.  
“IGNORE-ARTIFACTS” 예외를 추가했지만, “deliverables/findings/*” 읽기 허용은 리포트 생성 단계에서 유용하나 분석 단계 혼란 가능.
- 개선 제안  
RECON-TRUST 문구에 “recon이 불충분하거나 누락 시 제한적 독립 발견 허용”을 공통화.  
deliverables 예외는 “필요한 파일만 명시적으로 열기”를 더 강조해 broad scan을 억제.

**3) `prompts-openai/shared/_analysis-stop-rules.txt`**
- 강점  
시간/정체 기준이 현실적이며 “Analysis Blind Spots” 요구가 적절함.
- 리스크  
“Critical/High 발견 시 즉시 종료”는 대상을 놓칠 위험. 예: SQLi 한 건으로 다른 고위험 SSRF 경로가 스킵될 수 있음.
- 개선 제안  
“같은 카테고리 내 주요 경로 1–2개 추가 확인 후 종료” 같은 조건 추가.

**4) `prompts-openai/shared/_path-awareness.txt`**
- 강점  
상대/절대 경로 혼선 대응, 복구 절차가 실무적으로 좋음.
- 리스크  
“Repo Root Anchor” 문구는 변수 치환 실패 시 혼선을 야기할 수 있음.
- 개선 제안  
“{{REPO_PATH}}가 비어 있으면 `pwd` 기반으로 판단” 같은 실패 대비 문장 추가.

**5) `prompts-openai/shared/_vuln-scope.txt`**
- 강점  
외부 공격자 모델과 Playwright/curl 활용 지침이 공통화됨.
- 리스크  
Playwright 사용 지침이 “발견용”으로 강하게 표기돼 코드 기반 분석 우선순위와 충돌 가능.
- 개선 제안  
“코드 기반 분석 우선, Playwright는 검증에만 사용”을 공통 문구로 반영.

**6) `prompts-openai/shared/_fast-file-discovery.txt`**
- 강점  
빠른 탐색 지침은 유용함.
- 리스크  
`list_files` 도구가 없는 런타임에서도 지시가 그대로 남을 가능성.
- 개선 제안  
“list_files가 없으면 rg/find 사용” 문장 추가.

---

**개별 vuln 프롬프트 리뷰**

**1) SQLI (`prompts-openai/vuln-sqli.txt`)**
- 강점  
Slot-type 분류, bind/whitelist 매칭, NoSQL 위험 정의가 매우 좋음.  
“concat after sanitization invalidates”는 핵심.
- 리스크  
“Recon Injection Source Inventory”에 과하게 의존하면 실제 DB sink 탐지가 놓일 수 있음.  
“DB fingerprinting”은 좋지만 실제 앱이 ORM 사용으로 추론이 어려울 때 기준이 모호.
- 개선 제안  
“Recon gap 시 제한적 sink 탐색 허용”을 더 명확히.  
DB fingerprinting 실패 시 “driver/ORM 추론 기준” 추가.  
SQLi는 실무에서 “OR mapper”나 “dynamic filter”가 많으므로 “query builder safe/unsafe 패턴 표” 추가를 권장.

**2) CODEI (`prompts-openai/vuln-codei.txt`)**
- 강점  
CMDI/argv/flag injection 분류가 실무에 맞음.  
Deserialization/Expression/Prototype Pollution까지 포괄.
- 리스크  
“Injection Source Inventory” 항목에 CRLF, CSV/Excel 등 비실행성 이슈가 섞여 있어 범주가 너무 넓음. 결과적으로 포커스 분산 가능.  
“Hard Stop & Save Rule”에서 “모든 items 커버” 강제가 과도함.
- 개선 제안  
CODEI 내에서 “즉시 실행 가능 sink 우선, 비실행성 입력은 낮은 우선순위”로 정렬 규칙 추가.  
“모든 items 커버” 대신 “중요도별 최소 커버” 규칙화.

**3) XSS (`prompts-openai/vuln-xss.txt`)**
- 강점  
렌더 컨텍스트 분리, DOM sink 명시, CSP 검사 지침이 좋음.
- 리스크  
SPA 환경에서 실제 DOM sink가 코드에서 추적되기 어렵고, Playwright 제한이 너무 빡빡하면 검증이 불충분할 수 있음.  
서버-렌더 vs 클라이언트-렌더 구분이 좀 더 필요.
- 개선 제안  
“SPA에서 라우트 변경, API 응답 렌더 체인”을 추적하는 짧은 가이드 추가.  
Playwright cap은 유지하되 “증거 부족 시 제한적 추가 시도 허용” 단서 추가.

**4) SSRF (`prompts-openai/vuln-ssrf.txt`)**
- 강점  
방어 매칭 규칙, URL 구성/리다이렉트 검증, request class 분류가 탄탄함.
- 리스크  
“Callback verification”은 실제 환경에서 외부 콜백을 못 쓰는 경우가 많음. 이때 코드 기반으로 결론을 내릴 명시가 부족.
- 개선 제안  
“콜백 검증 실패 시 코드 기반 판단 우선” 문구 추가.  
“URL parsing libraries 취약 패턴” 예시(IPv6, userinfo, mixed encoding) 한 줄 추가.

**5) AUTH (`prompts-openai/vuln-auth.txt`)**
- 강점  
AuthN 범위를 명확히 분리했고, 세션/토큰/abuse 방어 카테고리 구분이 좋음.
- 리스크  
Auth 분석에 Playwright “RECOMMENDED”가 강해 코드 기반 접근과 충돌 가능.  
JWT 검증 기준이 일부 구현 환경에서 과도(예: opaque tokens).
- 개선 제안  
“토큰이 opaque면 JWT 분석 스킵, 세션 저장소 검증” 규칙 추가.  
Playwright는 “필수 아님, 코드로 유추 가능하면 생략” 문구 강화.

**6) PATHI (`prompts-openai/vuln-pathi.txt`)**
- 강점  
READ/WRITE/ARCHIVE 분류와 bounded traversal 개념 도입이 매우 실무적.
- 리스크  
WRITE sink 분석에서 “web-accessible” 판단 기준이 모호.  
Temp path/race는 실제 검증이 어려운데 요구 강도가 높음.
- 개선 제안  
“web-accessible 판단 기준: static/route serve 여부, CDN sync 여부” 한 줄 추가.  
Temp/Race는 “코드상 심각 패턴만 기록”으로 완화.

**7) SSTI (`prompts-openai/vuln-ssti.txt`)**
- 강점  
“Recon gap limited discovery” 규칙이 명확해서 실무에서 잘 맞음.  
템플릿 엔진별 위험 정의가 폭넓음.
- 리스크  
Handlebars/EJS/Pug 등은 “render string”과 “render file”이 혼재하는데, 그 구분이 약함.  
SSTI vs PATHI 경계가 여전히 모호할 수 있음.
- 개선 제안  
“SSTI는 expression evaluation, PATHI는 template 선택”을 한 줄 재강조.  
엔진별 위험 sink 예시를 2–3개 추가.

**8) AUTHZ (`prompts-openai/vuln-authz.txt`)**
- 강점  
Guard dominance 규칙과 side-effect 중심 정의는 매우 적절함.  
Batch, GraphQL, async까지 포함한 점이 좋음.
- 리스크  
파일 스캔 cap 10은 대규모 코드베이스에서 너무 낮을 수 있음.  
Playwright 권장과 “middleware-first analysis”가 충돌 가능.
- 개선 제안  
“middleware-first로 주요 라우트가 확인되면 파일 cap 완화 가능” 같은 조건부 허용 추가.  
“role context” 정의에 세션/JWT claims 검증 조건 강화.

---

**전반적 메타 리뷰 (8개 공통 관점)**

- 강점  
전반적으로 “증거 기반, 비루프, deliverable 강제”가 잘 잡혀 있음.  
화이트박스에서 필요한 “source→sink” 추적 요구가 뚜렷함.

- 리스크  
Recon 의존도가 높아서 recon 품질이 낮으면 전체 체인이 무너짐.  
“Playwright recommended”가 아직도 일부 프롬프트에서 과함.  
경계 취약점(복합 취약점) 처리 정책이 너무 엄격해 실제 원인/경로가 보고서에서 사라질 위험.

- 개선 제안  
1. 공통 규칙으로 “Recon gap 시 제한적 독립 발견 허용” 문구 삽입  
2. 공통 규칙으로 “교차 카테고리 원인 요약 1–2줄 허용” 추가  
3. Playwright는 공통적으로 “검증 목적, 코드 기반 우선”으로 통일  
4. 파일/검색 cap는 유지하되 “중대 증거 부족 시 1회 추가 연장” 같은 조건부 완화 도입

---

원하면 다음 단계로 넘어가서, 위 개선 제안을 실제 프롬프트에 반영할지 선택하도록 체크리스트 형태로 정리해줄게.
