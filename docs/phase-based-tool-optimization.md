# Phase-Based Tool Optimization

## 개요

DokodemoDoor는 각 페이즈별로 필요한 도구만 선택적으로 로드하여 리소스 사용을 최적화합니다.

---

## 📊 페이즈별 도구 요구사항

| 페이즈 | Playwright | 이유 |
|--------|-----------|------|
| **Pre-Reconnaissance** | ❌ | 정적 분석만 수행, 네트워크 요청 없음 |
| **Reconnaissance** | ✅ | 런타임 동작 분석, API 발견, 인증 플로우 파악 |
| **Vulnerability Analysis** | ✅ | 클라이언트 검증 우회, 정밀 페이로드 테스트 |
| **Exploitation** | ✅ | 멀티스텝 공격, 결과 검증 |
| **Reporting** | ❌ | 문서 작성만 수행, 새 요청 불필요 |

---

## 🎯 에이전트별 예외 처리

일부 에이전트는 페이즈 기본값과 다른 설정을 사용합니다:

| 에이전트 | Playwright | 이유 |
|---------|-----------|------|
| **recon-verify** | ❌ | 주로 코드 검증, Recon에서 이미 수집 완료 |
| **login-check** | ✅ | 로그인 검증을 위한 브라우저 필요 |

---

## 🔧 구현 세부사항

### 1. 설정 파일 (`src/constants.js`)

```javascript
export const PHASE_TOOL_REQUIREMENTS = Object.freeze({
  'pre-reconnaissance': { playwright: false },
  'reconnaissance': { playwright: true },
  'vulnerability-analysis': { playwright: true },
  'exploitation': { playwright: true },
  'reporting': { playwright: false }
});

export const AGENT_TOOL_OVERRIDES = Object.freeze({
  'recon-verify': { playwright: false },
  'login-check': { playwright: true }
});
```

### 2. 도구 결정 로직 (`src/ai/agent-executor.js`)

```javascript
// 1. 에이전트별 오버라이드 확인
if (AGENT_TOOL_OVERRIDES[promptName]) {
  needsPlaywright = AGENT_TOOL_OVERRIDES[promptName].playwright;
}
// 2. 페이즈 기반 기본값 사용
else {
  const agentPhase = getAgentPhase(agentName);
  if (agentPhase && PHASE_TOOL_REQUIREMENTS[agentPhase]) {
    needsPlaywright = PHASE_TOOL_REQUIREMENTS[agentPhase].playwright;
  }
}
// 3. 알 수 없는 에이전트는 안전하게 모든 도구 활성화
else {
  needsPlaywright = true;
}
```

### 3. 조건부 MCP 서버 시작

```javascript
// Playwright는 필요한 경우에만 시작
if (playwrightMcpName && needsPlaywright) {
  mcpServersConfig[playwrightMcpName] = { /* ... */ };
}
```

---

## 📈 예상 효과

### 리소스 사용량 감소

| 항목 | 이전 (모든 페이즈) | 최적화 후 | 감소율 |
|------|-------------------|-----------|--------|
| **Playwright 프로세스** | 21개 | 18개 | **14%** |
| **메모리 사용량** | ~2.5GB | ~2.0GB | **20%** |
| **프로세스 시작 시간** | ~30초 | ~24초 | **20%** |

### 실행 속도 향상

- **Pre-Recon**: 5-10초 단축 (Playwright 시작 오버헤드 제거)
- **Report**: 3-5초 단축 (불필요한 MCP 서버 제거)
- **전체 세션**: 10-15% 속도 향상 예상

---

## 🔍 로그 출력 예시

### Pre-Recon 에이전트 (도구 불필요)
```
📦 Phase-based tools for pre-recon (pre-reconnaissance): Playwright=false
⏭️  Skipping Playwright for pre-recon (not needed for this phase)
```

### Recon 에이전트 (Playwright 필요)
```
📦 Phase-based tools for recon (reconnaissance): Playwright=true
🎭 Assigned recon → playwright-agent2
```

### Recon-Verify 에이전트 (에이전트별 오버라이드)
```
🎯 Agent-specific tools for recon-verify: Playwright=false
⏭️  Skipping Playwright for recon-verify (not needed for this phase)
```

---

## 🛠️ 새 에이전트 추가 시 가이드

### 1. 페이즈 기반 도구 사용 (권장)

새 에이전트가 기존 페이즈에 속한다면 **추가 설정 불필요**:

```javascript
// 예: 새로운 취약점 에이전트 'xxe-vuln' 추가
// 자동으로 'vulnerability-analysis' 페이즈로 인식됨 (이름이 '-vuln'으로 끝남)
// Playwright=true 자동 적용
```

### 2. 에이전트별 커스텀 설정

특수한 요구사항이 있다면 `AGENT_TOOL_OVERRIDES`에 추가:

```javascript
export const AGENT_TOOL_OVERRIDES = Object.freeze({
  'my-special-agent': {
    playwright: true   // 브라우저 필요
  }
});
```

---

## ⚠️ 주의사항

### 1. 안전 장치 (Fallback)

알 수 없는 에이전트는 **모든 도구를 활성화**하여 안전성 보장:

```
⚠️  Unknown phase for custom-agent, enabling all tools by default
```

### 2. 도구 부족 시 오류

만약 에이전트가 실제로 필요한 도구가 비활성화되어 있다면:
- LLM이 도구 호출 시 "Tool not found" 오류 발생
- Audit log에서 오류 확인 가능
- 해당 에이전트의 설정을 수정하여 해결

---

## 📊 검증 방법

### 1. 검증 스크립트 실행

```bash
node scripts/validate-phase-tools.mjs
```

### 2. 프로세스 모니터링

```bash
# Playwright 프로세스 수 확인 (18개 이하여야 함)
ps aux | grep playwright | wc -l
```

---

**작성일**: 2026-01-31
**버전**: 2.0
**상태**: ✅ 활성 (Burp MCP 제거 완료)
