# Dokodemodoor File System Abuse (PATHI) Analysis Flow Audit

## 📋 점검 대상 경로 (PATHI 중심)
1. **[기초] Pre-Recon**: `pre-recon-code.txt` (파일 업로드, 다운로드 및 경로 트래버셜 지표 포착)
2. **[정찰] Recon**: `recon.txt` (파일 시스템 접점 매핑 및 사용된 권한/경로 정규화 로직 식별)
3. **[검증] Recon-Verify**: `recon-verify.txt` (코드 레벨에서 파일 시스템 싱크 도달 가능성 및 경계 검사 유무 확인)
4. **[동적] API Fuzzer**: `api-fuzzer.txt` (트래버셜 페이로드 주입을 통한 임의 파일 읽기/쓰기 시도)
5. **[분석] Vuln-PATHI**: `vuln-pathi.txt` (경로 정규화 우회, ZIP Slip 및 RCE 연계 업로드 정밀 분석)

---

## 🔍 단계별 상세 점검 결과

### 1단계: Pre-Recon (`pre-recon-code.txt`)
- **분석 지침**: `Injection & Dangerous Sink Hunter` 섹션에서 path traversal을 핵심 분석 영역으로 정의 (119행).
- **역할**: 코드 내에서 `fs.readFile`, `fs.writeFile` 등이 유저 인풋과 연결되는 지점 초기 포착.

### 2단계: Recon (`recon.txt`)
- **인벤토리**: Section 9.2를 통해 PATHI 출처(Source)를 독자적으로 집계 (311행).
- **파일 엔트리**: 업로드 엔드포인트와 다운로드 엔드포인트의 리스트를 확보하여 전수 조사 대상 설정.

### 3단계: Recon-Verify (`recon-verify.txt`)
- **실증 검증**: `CATEGORY: PATHI` 섹션을 통해 실제 파일 처리 로직의 파일:라인 증거 확보 (13행).
- **집중 타겟팅**: `path.join`이나 `path.resolve` 사용 시 베이스 경로를 벗어날 수 있는지 물리적 확인.

### 4단계: API Fuzzer (`api-fuzzer.txt`)
- **동적 정찰**: `../../etc/passwd`와 같은 전형적인 페이로드를 주입하여 서버의 차단 정책 및 에러 응답 수집.
- **안정성**: `BASH-PRECISION` 규칙을 통해 복잡한 경로 문자열 전송 시 쉘 특수문자 왜곡 방지.

### 5단계: Vuln-PATHI (`vuln-pathi.txt`) -- **최근 대폭 강화됨**
- **파일 시스템 오남용 전수 조사**: 단순 트래버셜을 넘어 LFI/RFI, ZIP Slip, Tar Slip 등 모든 파일 관련 위협 분석 (Section 1).
- **RCE 연계 업로드 감사**: 웹 루트(`public/`, `static/`) 내에 파일을 쓸 수 있는 지점을 'Critical'로 분류하여 집중 감시 (Section 2.1).
- **임시 파일 레이스 컨디션**: `/tmp` 등 공유 디렉토리에서의 심볼릭 링크(Symbolic Link) 활용 우회 가능성 체크 (Section 2.1).
- **고급 우회 기법 대응**: **Null Byte (`%00`)** 주입 및 **Windows 예약 파일명(CON, PRN, AUX 등)**을 이용한 경계 검사 우회 가능성 전수 점검 (Section 9.1).
- **정확한 방어 모델 대조**: 단순히 `replace`를 쓰는 블랙리스트 방식이 아닌, `resolve + startsWith` 기반의 경계 검사 유무를 확인.

---

## ✅ 점검 결론
PATHI 분석 체인은 **"시스템 장악으로 이어지는 파일 인젝션"**을 포착하는 데 특화됨. 특히 윈도우/리눅스 환경의 특성을 모두 고려한 우회 기법과 공유 디렉토리에서의 Race Condition까지 커버하는 높은 수준의 전문성을 확보함.

---
*Prepared by Antigravity (Advanced Agentic Coding)*
