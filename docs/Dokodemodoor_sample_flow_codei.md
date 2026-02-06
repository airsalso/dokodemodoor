# Dokodemodoor Code & Command Injection (CODEI) Analysis Flow Audit

## 📋 점검 대상 경로 (CODEI 중심)
1. **[기초] Pre-Recon**: `pre-recon-code.txt` (OS 명령 실행, eval, 역직렬화 지표 포착)
2. **[정찰] Recon**: `recon.txt` (시스템 명령어 접점 매핑 및 사용된 프로세스 실행 라이브러리 식별)
3. **[검증] Recon-Verify**: `recon-verify.txt` (코드 레벨에서 위험한 실행 싱크 도달 가능성 및 인자 분리 유무 확인)
4. **[동적] API Fuzzer**: `api-fuzzer.txt` (명령어 주입 페이로드를 통한 응답 기반 RCE 확인)
5. **[분석] Vuln-CODEI**: `vuln-codei.txt` (인자 주입, 프로토타입 오염 연계 RCE 및 역직렬화 가젯 체인 정밀 분석)

---

## 🔍 단계별 상세 점검 결과

### 1단계: Pre-Recon (`pre-recon-code.txt`)
- **분석 지침**: `command exec, deserialization`을 위험 싱크 헌팅의 핵심으로 지정 (119행).
- **역할**: 코드 베이스 전체에서 `child_process`, `exec`, `eval` 등이 노출된 지점 초기 포착.

### 2단계: Recon (`recon.txt`)
- **인벤토리**: Section 9.1을 통해 비특정 인젝션 출처(Source)를 독자적으로 집계 (310행).
- **실전 타겟**: 시스템 명령어를 호출하는 모든 엔드포인트와 데이터 역직렬화가 발생하는 입구 확보.

### 3단계: Recon-Verify (`recon-verify.txt`)
- **지배력 분석**: 프로세스 실행 시 `shell: true` 옵션 사용 여부와 인자(argv)가 배열로 안전하게 전달되는지 전수 검증.
- **증거**: `findings/recon-verify/codei.md`에 위험한 `eval` 사용 또는 역직렬화 라이브러리 정보 기록.

### 4단계: API Fuzzer (`api-fuzzer.txt`)
- **동적 정찰**: `; ls`, `$(whoami)`, `` `id` `` 등의 페이로드를 주입하여 서버의 명령어 실행 여부 실전 확인.
- **안정성**: `BASH-PRECISION` 규칙을 통해 복잡한 쉘 메타문자가 포함된 요청도 패킷 손상 없이 전송.

### 5단계: Vuln-CODEI (`vuln-codei.txt`) -- **최근 대폭 강화됨**
- **명령어 실행Z 전용 분석**: OS 명령어 주입(CMDI), 코드 주입(CODE), 역직렬화(DESERIALIZE)를 체계적으로 분류 (Section 1).
- **인자 주입(Flag Injection) 감시**: 명령어 자체는 안전하더라도 인자(`-o`, `--output` 등)를 조작하여 시스템을 탈취하는 시나리오 추가 (Section 8.1).
- **프로토타입 오염 연계 RCE**: Node.js 환경에서 프로토타입 오염을 통해 `spawn`의 `env`나 `shell` 옵션을 변조하는 고급 RCE 기법 감사 지침 반영 (Section 8.2).
- **역직렬화 가젯 체인 탐색**: `__destruct`, `__wakeup`, `toJSON` 등 자동 실행되는 마법 메서드를 통한 가젯 체인 형성 가능성 정밀 분석 강화 (Section 8.2).
- **정확한 방어 모델 대조**: 단순히 세미콜론(`;`) 등을 막는 블랙리스트 방식이 아닌, 객체화된 인자(argv array) 사용 여부를 핵심 지표로 설정.

---

## ✅ 점검 결론
Code & Command Injection 분석 체인은 **"시스템 전체를 포착하는 치명적 인젝션"**을 탐지하는 데 최적화됨. 특히 단순한 명령어 주입을 넘어 인자 조작, 프로토타입 오염, 역직렬화 가젯 체인 등 공격자의 고도화된 침투 시나리오를 논리적으로 감제할 수 있는 '최상급 보안 지능'을 확보함.

---
*Prepared by Antigravity (Advanced Agentic Coding)*
