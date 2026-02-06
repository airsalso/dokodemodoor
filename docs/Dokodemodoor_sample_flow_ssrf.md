# Dokodemodoor SSRF Analysis Flow Audit

## 📋 점검 대상 경로 (SSRF 중심)
1. **[기초] Pre-Recon**: `pre-recon-code.txt` (아웃바운드 HTTP 요청 및 Webhook 테스터 포착)
2. **[정찰] Recon**: `recon.txt` (API Proxy, Relay 엔드포인트 매핑 및 사용된 라이브러리 식별)
3. **[검증] Recon-Verify**: `recon-verify.txt` (코드 레벨에서 SSRF 싱크 도달 가능성 검증)
4. **[동적] API Fuzzer**: `api-fuzzer.txt` (동적 주입을 통한 블라인드 SSRF 및 응답 기반 핑거프린팅)
5. **[분석] Vuln-SSRF**: `vuln-ssrf.txt` (프로토콜 오남용 및 클라우드 메타데이터 탈취 분석)

---

## 🔍 단계별 상세 점검 결과

### 1단계: Pre-Recon (`pre-recon-code.txt`)
- **분석 지침**: `SSRF / Outbound Request Tracer`를 8대 영역 중 하나로 지정 (121행).
- **역할**: 코드 내에서 `fetch`, `axios`, `http.request` 등이 유저 인풋과 연결되는 지점 초기 포착.

### 2단계: Recon (`recon.txt`)
- **인벤토리**: Section 9.6을 통해 SSRF 출처(Source)를 독자적으로 집계 (315행).
- **기술 스택**: 백엔드에서 아웃바운드 요청에 사용하는 모듈(axios, request 등)과 해당 설정 확인.

### 3단계: Recon-Verify (`recon-verify.txt`)
- **Overlay 생성**: `CATEGORY: SSRF`를 통해 실제 코드 기반의 'File:Line' 증거 확보 (13행).
- **증거**: 서버가 요청을 보내는 정확한 위치와 리다이렉트 정책 확인 지시.

### 4단계: API Fuzzer (`api-fuzzer.txt`)
- **동적 정찰**: 외부 콜백 서버(Webhook.site 등) 주율을 유도하여 실제 서버의 아웃바운드 발생 여부 확인.
- **안정성**: `BASH-PRECISION` 규칙을 통해 복잡한 URL 인코딩 페이로드도 안전하게 실행.

### 5단계: Vuln-SSRF (`vuln-ssrf.txt`) -- **최근 대폭 강화됨**
- **다양한 프로토콜 감시**: `http(s)`를 넘어 `file`, `gopher`, `dict`, `ftp` 등 위험한 스킴 주입 여부 분석 지시 (2.1행).
- **인프라 타겟팅**: AWS/GCP/Azure 메타데이터(`169.254.169.254`) 및 쿠버네티스 API를 표적으로 설정.
- **특수 싱크 분석**: PDF 변환기, 이미지 처리기, Headless Browser 등 미디어 관련 SSRF 싱크 탐색 강화.
- **방어 로직 검증**: 블랙리스트 방식의 한계와 DNS Rebinding, 리다이렉트 우회 가능성 정밀 분석.

---

## ✅ 점검 결론
SSRF 분석 체인은 **"인프라 침투형 시나리오"**를 완벽하게 지원하도록 진화함. 특히 클라우드 환경의 특수성과 비주류 프로토콜(Gopher 등)을 이용한 내부 서비스 공격 가능성을 탐지할 수 있는 '고급 공격 지능'을 확보함.

---
*Prepared by Antigravity (Advanced Agentic Coding)*
