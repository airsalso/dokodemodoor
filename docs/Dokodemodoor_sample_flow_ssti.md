# Dokodemodoor SSTI Analysis Flow Audit

## 📋 점검 대상 경로 (SSTI 중심)
1. **[기초] Pre-Recon**: `pre-recon-code.txt` (템플릿 엔진 사용 지점 및 SSR 싱크 포착)
2. **[정찰] Recon**: `recon.txt` (엔진 유형 식별 및 SSTI 관련 주입 경로 매핑)
3. **[검증] Recon-Verify**: `recon-verify.txt` (코드 레벨에서 선정된 SSTI 후보지 도달 가능성 확인)
4. **[동적] API Fuzzer**: `api-fuzzer.txt` (API 응답 딜레이나 500 에러를 통한 템플릿 엔진 힌트 수집)
5. **[분석] Vuln-SSTI**: `vuln-ssti.txt` (엔진별 샌드박스 우회 가능성 및 정밀 분석)

---

## 🔍 단계별 상세 점검 결과

### 1단계: Pre-Recon (`pre-recon-code.txt`)
- **분석 지침**: `template injection` 및 `SSR rendering sinks`를 8대 분석 영역으로 명시 (119행).
- **역할**: 전체 코드 베이스에서 어떤 템플릿 엔진이 사용되는지 초기 징후 파악.

### 2단계: Recon (`recon.txt`)
- **분류**: Section 9.3을 통해 SSTI 출처(Source)를 독자적으로 집계 (312행).
- **동적 정찰**: 브라우저 응답 헤더나 에러 메시지에서 엔진 힌트(예: "Express", "Pug", "EJS") 추출 시도.

### 3단계: Recon-Verify (`recon-verify.txt`)
- **강력한 전수 조사**: `CATEGORY: SSTI` 섹션을 통해 누락 없는 검증 overlay 생성 지시 (13행).
- **증거**: `findings/recon-verify/ssti.md`에 엔진 버전 및 렌더링 방식 상세 기록.

### 4단계: API Fuzzer (`api-fuzzer.txt`)
- **엔진 핑거프린팅**: 의도적으로 깨진 템플릿 문법을 주입하여 서버의 반응(500 에러 등)을 분석.
- **안정성**: `BASH-PRECISION` 규칙으로 복잡한 쉘 페이로드 실행 시 안정성 확보.

### 5단계: Vuln-SSTI (`vuln-ssti.txt`) -- **최근 강화됨**
- **엔진 클래스 분류**: Sandboxed vs Unsandboxed 구분을 통한 차별화된 공격 로직 전개 (187행).
- **방어 오해 제거**: `Auto-escaping`이 SSTI를 막지 못한다는 점을 명시하여 분석 누락 방지 (193행).
- **고급 분석 추가**:
    - **A. 핑거프린팅**: `package.json` 등 의존성 파일을 먼저 조회하여 엔진 확정 지시.
    - **B. 위험 API 리스트**: `render`, `compile`, `SafeString` 등 엔진별 핵심 싱크 리스트업.
    - **C. Second-Order**: DB에 저장된 데이터가 나중에 템플릿에서 렌더링되는 지점 추적 지시.

---

## ✅ 점검 결론
SSTI 분석 체인은 특히 **"엔진별 특화 분석"** 능력이 대폭 강화되었음. 템플릿 엔진의 복잡한 계층 구조(Template -> AST -> JS Code)를 이해하고, 단순 데이터 렌더링과 실행 가능 표현식을 구분해내는 지능적인 분석이 가능해짐.

---
*Prepared by Antigravity (Advanced Agentic Coding)*
