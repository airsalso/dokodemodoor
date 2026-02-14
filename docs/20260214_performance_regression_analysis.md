# 검사 시간 증가·취약점 검출 감소 원인 분석 (로그 기반)

**세션**: `457966f3-ca40-4c92-a269-3468729de51c`  
**로그**: `audit-logs/localhost_457966f3-ca40-4c92-a269-3468729de51c/console.log`  
**session.json 메트릭**: total_duration_ms 16,338,471 (~4.54h), total_cost_usd 94.83

---

## 1. 검사 시간이 많이 늘어난 원인

### 1.1 [주요] 병렬도 1로 설정됨

- **로그**: `⚡ Concurrency: max 1 agents in parallel (semaphore pool)` (console.log 14450행)
- **설정**: `.env` 76행 `DOKODEMODOOR_PARALLEL_LIMIT=1`
- **영향**: vulnerability-analysis phase에서 8개 에이전트가 **순차 실행**됨.  
  병렬 5일 때 대비 wall-clock이 최대 ~5배 길어질 수 있고, 1이면 **전부 순차**라 vuln phase만으로도 88분+ 소요.
- **결론**: **시간 증가의 가장 큰 원인.**  
  병렬도를 5(또는 3~5)로 올리면 vuln phase 시간이 크게 줄어듦.

### 1.2 Pre-recon이 전체의 절반

- **session.json**: pre-recon `duration_ms: 8,316,113` (~138분), **전체 대비 50.9%**
- **로그**: pre-recon이 Turn 26+ 까지 진행, "History large. Compressing..." 다수 발생
- **영향**: 한 에이전트가 138분 소비 → 전체 런타임·비용의 절반을 차지.
- **가능 원인**: 턴 수 과다, 컨텍스트 비대으로 인한 반복/재시도, 또는 모델 지연.  
  (개선 자체보다는 **기존 pre-recon 특성 + 병렬 1**이 겹쳐서 전체 시간이 길게 보일 수 있음.)

### 1.3 Loop/Stagnation·Nudging 반복

- **로그**: "Loop/Stagnation detected" 50회 이상, "Empty response detected. Nudging" 다수
- **영향**: 같은 턴에서 도구만 반복하거나 빈 응답 후 Nudging으로 턴이 낭비됨 → 에이전트당 턴 수·실행 시간 증가.
- **결론**: 시간 증가의 보조 원인. (스테그네이션 감지/너징 정책은 유지하되, 원인 턴 수·컨텍스트는 별도 조정 필요.)

---

## 2. 취약점을 더 못 찾게 된 원인

### 2.1 [주요] 프롬프트 강제 트리밍 (140000자)

- **로그**:  
  `⚠️  Prompt size 277416 chars exceeds 140000. Trimming...`  
  `⚠️  Prompt size 515837 chars exceeds 140000. Trimming...`  
  `⚠️  Prompt size 754240 chars exceeds 140000. Trimming...`  
  등 **다수** (277k, 515k, 754k → 140k로 절단)
- **설정**: `.env` 31행 `VLLM_MAX_PROMPT_CHARS=140000`
- **영향**:  
  - recon/recon_verify/api_fuzzer 등 **주입 컨텍스트가 140k 초과분은 잘림**.  
  - 에이전트가 엔드포인트·인젝션 후보·검증 결과를 **일부만** 보게 됨.  
  - 타겟 정보가 잘리면 잘못된/빈 타겟 위주로 동작 → **취약점 검출 감소**.
- **결론**: **취약점 검출 감소의 가장 유력한 원인.**  
  한계를 올리거나, 140k 안에 들어가도록 **주입 컨텍스트를 요약/선택**하는 방식이 필요.

### 2.2 History large. Compressing (259회)

- **로그**: "History large. Compressing..." **259회**
- **영향**: 대화 히스토리 압축 시 **과거 턴의 도구 결과·지시가 잘릴 수 있음**.  
  재검색·반복 시도가 늘고, 이미 찾은 정보를 잃어 **중복 작업 + 검출 누락** 가능.
- **결론**: 취약점 검출 감소의 보조 원인.  
  압축 윈도/임계값은 유지하되, **중요한 recon/타겟 정보는 시스템/최근 메시지에 남도록** 설계하는 것이 좋음.

### 2.3 (참고) 산출물 유실

- 이전 분석대로 sqli/codei/ssti 산출물이 디스크에서 사라진 상태.  
  그 결과만으로 “검출이 줄었다”고 단정할 수는 없지만, **최종 집계·리포트에는 반영이 안 될 수 있음**.

---

## 3. 요약 및 권장 조치

| 구분 | 원인 | 권장 |
|------|------|------|
| **시간 증가** | `DOKODEMODOOR_PARALLEL_LIMIT=1` → vuln phase 순차 실행 | `.env`에서 `DOKODEMODOOR_PARALLEL_LIMIT=5` (또는 3~5) 로 복원 |
| **시간 증가** | Pre-recon 138분 (50.9%) | pre-recon 턴/컨텍스트·서브에이전트 정책 검토 (별도 태스크) |
| **시간 증가** | Loop/Stagnation·Nudging 다수 | 스테그네이션 감지 유지, 턴 한도·컨텍스트 정책으로 반복 감소 검토 |
| **검출 감소** | `VLLM_MAX_PROMPT_CHARS=140000` → 277k~754k 프롬프트가 140k로 잘림 | 한계 상향(예: 200k~300k) **또** 주입 컨텍스트 요약/선택으로 140k 이내 유지 |
| **검출 감소** | History Compressing 259회로 과거 컨텍스트 손실 | 컨텍스트 압축 시 “타겟/엔드포인트 요약”은 유지하도록 로직 검토 |

**즉시 적용 권장**

1. **`.env`**  
   - `DOKODEMODOOR_PARALLEL_LIMIT=5` (또는 3 이상)  
   - 필요 시 `VLLM_MAX_PROMPT_CHARS` 상향(예: 200000) 또는 주입 컨텍스트를 140k 이하로 맞추는 구조로 변경

2. **재실행**  
   - 동일 타겟으로 위 설정 변경 후 한 번 더 돌려서  
     - vuln phase 시간이 줄었는지,  
     - “Prompt size … exceeds … Trimming” 발생이 줄었는지,  
     - 취약점 개수/품질이 나아졌는지 확인

이 문서는 **해당 세션 로그와 .env 설정**만을 근거로 한 분석입니다.
