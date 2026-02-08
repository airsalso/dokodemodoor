# Intelligent Context Injection: Tool-AI Synergy System

## 🚀 Overview

DokodemoDoor는 전통적인 보안 진단 도구(Static Analysis, SCA)의 **정확성과 속도**를 AI 에이전트의 **유연한 논리 추론**과 결합한 "지능형 컨텍스트 주입 시스템"을 채택하고 있습니다.

단순히 도구를 실행하는 것을 넘어, 도구가 생성한 "요약 맥락(Summary Context)"을 AI의 사고 과정 최상단에 주입함으로써 에이전트가 방대한 코드베이스 내에서 취약 가능성이 높은 지점(Hotspots)을 즉시 파악하고, 도구가 놓치는 복잡한 논리 결함에 집중할 수 있도록 지원합니다.

---

## 🏗️ Architecture

시스템은 크게 세 가지 레이어로 구성됩니다:

### 1. Foundation Layer: Semgrep Security Surface Analysis
- **스크립트**: `scripts/semgrep-analyzer.mjs`
- **역할**: 범용적인 보안 취약점 패턴을 초고속으로 탐지합니다.
- **특징**:
    - **다중 언어 지원**: JS/TS, Python, Java, Go 언어를 자동으로 감지하여 적절한 규칙 적용.
    - **정합성**: 탐지된 결과를 `deliverables/semgrep_analysis_deliverable.md`라는 표준화된 결과물로 생성.
    - **지능형 타겟팅**: 단순 텍스트 검색보다 정밀한 추상 구문 트리(AST) 기반 탐지 수행.

### 2. Injection Layer: Prompt-Manager Integration
- **모듈**: `src/prompts/prompt-manager.js`
- **역할**: 에이전트 실행 직전, `deliverables` 폴더 내의 보안 컨텍스트를 수집하여 프롬프트에 주입합니다.
- **주입 항목**:
    - `osv_analysis_deliverable.md` (오픈소스 취약점/SCA 정보)
    - `semgrep_analysis_deliverable.md` (정적 분석 기반 취약점 후보지)
- **플레이스홀더**: 모든 프롬프트 내의 `{{SECURITY_CONTEXT}}` 변수를 통해 데이터가 전달됩니다.

### 3. Reasoning Layer: Tool-AI Synergy Strategy
- **철학**: **"도구의 한계(Ceiling)가 AI의 시작점(Floor)이다."**
- **가이드**: 에이전트에게 도구가 찾은 결과에 매몰되지 말 것을 강력히 지시합니다.
    - **Verify**: 도구가 찾은 후보지가 실제 네트워크 전송 경로와 연결되는지(Reachability) 확인.
    - **Beyond**: 도구가 이해하지 못하는 비즈니스 로직, 멀티 스텝 공격, 인증 우회 등 고차원적 취약점 탐색에 리소스의 80%를 투입.

---

## 🔄 Execution Workflow

1.  **Phase 1 (Pre-Recon) 시작**: `src/phases/pre-recon.js`가 구동됩니다.
2.  **Wave 0 (Foundation Scan)**: 다른 스캔이 시작되기 전 `semgrep-analyzer.mjs`가 먼저 실행되어 "보물 지도(Hotspots)"를 만듭니다.
3.  **Agent Strategy Injection**: 에이전트(`pre-recon`, `recon-verify` 등)가 생성될 때, 위에서 만든 지도와 OSV 분석 결과가 실시간으로 프롬프트에 주입됩니다.
4.  **Autonomous Investigation**: 에이전트는 이미 취약 지점을 알고 있는 상태에서 탐색을 시작하므로, 불필요한 파일 탐색 턴(Turn)을 줄이고 정밀 분석에 집중합니다.

---

## 📂 Key Files & Deliverables

| 파일 이름 | 목적 |
| :--- | :--- |
| `scripts/semgrep-analyzer.mjs` | 다중 언어 보안 패턴 스캐너 (Generic) |
| `src/prompts/prompt-manager.js` | 컨텍스트 자동 주입 로직 보유 모듈 |
| `deliverables/semgrep_analysis_deliverable.md` | AI 에이전트 전용 정적 분석 컨텍스트 |
| `deliverables/osv_analysis_deliverable.md` | SCA 컨텍스트 (오픈소스 취약점) |

---

## 💡 Benefits for Engineers

- **속도 향상**: 에이전트가 "취약한 곳이 어디인가?"를 찾는 탐색 턴을 대폭 절약.
- **범용성 확보**: 특정 언어나 기술 스택(e.g., Juice-Shop)에 하드코딩되지 않고 모든 웹 앱 스택 수용.
- **정밀도 향상**: 도구의 패턴 매칭 결과와 AI의 흐름 분석(Taint Analysis)이 결합되어 오탐(False Positive)을 혁신적으로 제거.

---
**Last Updated**: 2026-02-07
**Status**: ACTIVE & GENERIC
