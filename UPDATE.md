# DokodemoDoor 개선 실행 플랜 (의사결정용)

아래 플랜은 이전 평가 리포트를 기반으로 한 **주 단위 일정 + 작업 항목 + 산출물 + KPI + 리스크/완화**를 포함한 구체 실행안입니다.

## 가정/전제
- 지원 언어: 1차는 JS/TS
- 운영 제약: 원본 레포 변경 금지(읽기 전용 복제본)
- 목표 KPI: 오탐률 감소, 재현률 증가, 실행 시간 감소, 리포트 품질 증가
- 팀 구성 가정: 2~3명

---

## Phase 0: 기준선 확보 (1주)

### 작업
- 현재 파이프라인에서 3개 벤치마크 타겟 선정(단순/중간/복잡)
- 측정 로깅 추가: 실행시간, 발견 건수, 재현 성공률, 오탐률

### 산출물
- 기준선 리포트(지표표 + 대표 사례 5개)

### KPI
- 기준선 지표 확보(재현률/오탐률/시간)

### 수정 위치
- `src/utils/metrics.js`
- `src/audit/`
- `src/ai/agent-executor.js`

---

## Phase 1: 실행 안전성 + 인덱싱 기반 강화 (4~6주)

### Week 1–2

#### 작업
- 분석 대상 레포 읽기 전용 복제본 적용
- Git clean/reset 사용 경로를 안전모드로 전환(옵션화)
- deliverables 경로 분리(원본 영향 차단)

#### 산출물
- 안전모드 플래그(예: `--safe-mode`)
- 복제 디렉토리 정책 문서

#### KPI
- 원본 레포 변경 0건

#### 수정 위치
- `src/setup/environment.js`
- `src/utils/git-manager.js`
- `dokodemodoor.mjs`

### Week 3–4

#### 작업
- 경량 코드 인덱서 도입(라우트, 컨트롤러, 모델, 주요 sink 추출)
- 인덱스 저장(`outputs/index.json`) 후 에이전트 컨텍스트로 주입

#### 산출물
- 인덱스 파일 포맷 정의 + 샘플

#### KPI
- 분석 시간 20~30% 감소

#### 수정 위치
- `src/phases/pre-recon.js`
- `src/ai/providers/vllm-provider.js`
- `src/utils/`

### Week 5–6

#### 작업
- 리포트 전처리 자동화(중복 제거/요약/중요도 정렬)

#### 산출물
- 보고서 품질 개선 전/후 비교

#### KPI
- 리포트 중복율 30% 감소

#### 수정 위치
- `src/phases/reporting.js`

### Phase 1 게이트
- 재현률 +10% 또는 실행시간 -20% 중 하나 달성 시 Phase 2 진행

---

## Phase 2: 정확도·신뢰성 강화 (8~10주)

### Week 7–10

#### 작업
- AST 기반 sink/source 추출(1차는 JS/TS)
- 데이터플로우 경로 추적(간단 타인트)
- 결과를 에이전트 입력으로 제공(RAG 형태)

#### 산출물
- `outputs/taint-map.json`
- `outputs/sinks.json`

#### KPI
- 오탐률 30% 감소

#### 수정 위치
- 신규: `src/analysis/ast/`, `src/analysis/taint/`
- 주입: `src/ai/agent-executor.js`, `src/ai/providers/vllm-provider.js`

### Week 11–14

#### 작업
- 동적 검증 증거 포맷 표준화(요청/응답/세션/스크린샷 포함)
- exploit evidence 저장 규칙 강화

#### 산출물
- Evidence JSON schema + 샘플

#### KPI
- 재현률 20% 증가

#### 수정 위치
- `mcp-server/src/tools/save-deliverable.js`
- `src/ai/agent-executor.js`
- `src/checkpoint-manager.js`

### Phase 2 게이트
- 오탐률 30% 감소 + 재현률 15% 증가 달성 시 Phase 3 진행

---

## Phase 3: 커버리지 확장 (3~6개월)

### Month 1–2

#### 작업
- SCA + 시크릿 스캔 통합
- 결과를 리포트 섹션으로 병합

#### 산출물
- `deliverables/sca_summary.md`
- `deliverables/secret_findings.md`

#### KPI
- 신규 유형 20% 이상 발견

#### 수정 위치
- `src/phases/pre-recon.js`
- `src/phases/reporting.js`

### Month 3–4

#### 작업
- 비즈니스 로직 전용 에이전트 설계
- 정책/워크플로우 기반 취약점 템플릿 정의

#### 산출물
- `prompts-openai/vuln-business-logic.md`

#### KPI
- 로직 이슈 1건 이상 재현

### Month 5–6

#### 작업
- API fuzzing 강화(스펙 추론 + coverage-guided)

#### 산출물
- fuzz 결과 통합 리포트

#### KPI
- API 취약점 발견률 15% 증가

---

## 인력/역할 제안
- 보안 엔지니어 1: 정적분석/검증 설계
- 백엔드 엔지니어 1: 파이프라인/인덱서/도구 통합
- ML/LLM 엔지니어 1: RAG, 컨텍스트 주입, 에이전트 품질

---

## 리스크 & 완화
- LLM 품질 편차: 인덱스/타인트 기반 근거 제공
- 레포 변경 리스크: safe-mode + 복제 레포
- 속도 저하: 인덱스 캐시 + 증분 분석

---

## 결정 체크리스트
- Phase 1만으로도 시간/품질 개선이 충분한가?
- 엔터프라이즈 적용 목표라면 Phase 2는 필수
- Phase 3는 커버리지 확장 단계로 시장 확장 전략과 연계 필요
