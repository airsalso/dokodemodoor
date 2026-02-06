# Recon 검증 오버레이 & 불변 Recon 맵

## 요약
이번 업데이트는 여러 에이전트가 동일한 마스터 recon 보고서를 반복 덮어쓰면서 발생하던 DLP 트리거 문제를 해결합니다. recon 결과는 불변(immutable)으로 고정하고, 검증/퍼징 결과는 별도 전달물로 분리했습니다. 이후 vuln/exploit 에이전트는 불변 recon 맵과 검증 오버레이를 함께 참조해 근거 중심의 분석을 수행합니다.

## 문제 정의
기존 파이프라인은 `recon-verify`와 `api-fuzzer`가 `deliverables/recon_deliverable.md`를 덮어쓰는 구조였습니다. 그 결과:
- 반복적인 파일 재작성/축약으로 DLP 트리거 발생
- 어떤 단계가 어떤 내용을 변경했는지 추적 불가
- vuln/exploit 입력이 매번 달라지는 불안정성

## 설계 목표
- recon 단계 산출물은 완료 이후 변경 금지
- 검증 및 퍼징은 별도 전달물로 분리
- downstream 에이전트가 새 오버레이를 확실히 읽도록 입력 경로 명시

## 새로운 전달물 계약
- `deliverables/recon_deliverable.md` (RECON): recon 단계의 불변 마스터 맵
- `deliverables/recon_verify_deliverable.md` (RECON_VERIFY): File:Line 근거가 포함된 검증 오버레이
- `deliverables/api_fuzzer_deliverable.md` (API_FUZZ_REPORT): 퍼징 결과 전용 전달물, recon 갱신 없음

## 동작 변경 사항
1. `recon-verify`는 더 이상 `recon_deliverable.md`를 수정하지 않음
2. `api-fuzzer`는 더 이상 `recon_deliverable.md`를 업데이트하지 않음
3. Vuln/Exploit 에이전트는 `recon_verify_deliverable.md`를 권위 있는 오버레이로 참조
4. 보고서 단계에 검증 오버레이와 퍼징 전달물이 포함됨

## 코드 변경 (수정 파일)
- `mcp-server/src/types/deliverables.js`
  - `RECON_VERIFY` 전달물 타입 추가
  - `recon_verify_deliverable.md`로 매핑
- `src/ai/providers/vllm-provider.js`
  - `recon-verify` 강제 타입을 `RECON_VERIFY`로 지정
  - 완료 가드에서 `RECON_VERIFY` 저장 요구
  - API fuzzer 힌트에서 RECON 업데이트 요구 제거
- `src/constants.js`
  - `recon-verify` 검증: recon + recon-verify 파일 존재 확인
  - `api-fuzzer` 검증에서 recon 갱신 여부 체크 제거
- `src/checkpoint-manager.js`
  - vuln/exploit 컨텍스트에 `recon_verify_deliverable.md` 주입
  - api-fuzzer 컨텍스트에서 recon 업데이트 안내 제거
- `src/phases/reporting.js`
  - 보고서 합성/입력 준비에 `recon_verify_deliverable.md`, `api_fuzzer_deliverable.md` 포함

## 프롬프트 변경
- `prompts-openai/recon-verify.txt`
  - 검증 오버레이만 출력
  - `RECON_VERIFY`로 저장
  - `recon_deliverable.md` 수정 금지
  - 제목 필수: `# Recon Verification Deliverable`
- `prompts-openai/api-fuzzer.txt`
  - RECON 업데이트 지시 제거
  - `API_FUZZ_REPORT`만 저장
- `prompts-openai/vuln-*.txt`, `prompts-openai/exploit-*.txt`
  - `recon_verify_deliverable.md` 추가 입력
- `prompts-openai/report-executive.txt`
  - `recon_verify_deliverable.md`, `api_fuzzer_deliverable.md`를 보조 입력으로 활용

## 파이프라인 영향
긍정적 효과:
- recon 맵이 고정되어 재작성/축약 위험 제거
- 검증 근거가 별도 오버레이로 명확화
- DLP 트리거 가능성 감소

필수 재실행:
- `recon-verify` 재실행으로 `recon_verify_deliverable.md` 생성
- `api-fuzzer` 재실행으로 `api_fuzzer_deliverable.md` 생성

## 권장 재실행 순서
1. `recon-verify` (검증 오버레이 생성)
2. `api-fuzzer` (퍼징 전달물 생성)
3. vuln/exploit 단계 재개

## 주의 / 리스크
- `recon_deliverable.md`에 퍼징 하이라이트가 존재한다고 가정하는 로직은 더 이상 유효하지 않음
- 검증 오버레이가 우선이며, 충돌 시 오버레이를 우선 적용
