# WSL2 Ubuntu에서 re-scanner 빠른 테스트 가이드

WSL2 Ubuntu 환경에서 `re-scanner.mjs`를 **최소 설정**으로 실행·검증하는 절차입니다.

---

## 1. 사전 확인 (필수)

```bash
# 프로젝트 루트에서
cd /home/ubuntu/dokodemodoor

# Node.js 18+
node --version

# Git (체크포인트용)
git --version

# Linux 기본 도구 (Phase 1 인벤토리용)
file --version
readelf --version
```

`file` / `readelf` 없으면:

```bash
sudo apt update && sudo apt install -y file binutils
```

---

## 2. 의존성 설치

```bash
# 루트 + mcp-server
npm run build

# RE MCP 서버들 (Phase 1만 테스트 시 re-sigcheck만 있어도 됨)
cd mcp-servers/re-sigcheck-mcp && npm install && cd ../..
```

Phase 1만 돌릴 때는 `re-sigcheck-mcp`만 설치해도 됩니다. 나중에 Phase 2 이상을 쓰면 나머지도 설치합니다.

```bash
# (선택) 전체 RE MCP 서버
for d in mcp-servers/re-*/; do (cd "$d" && npm install); done
```

---

## 3. LLM 설정 (.env)

에이전트가 동작하려면 **LLM 엔드포인트**가 필요합니다.

```bash
# .env 파일이 없다면
cp .env.example .env
# .env 편집
```

최소한 다음 정도는 설정합니다 (vLLM 기준 예시).

```env
DOKODEMODOOR_LLM_PROVIDER=vllm
VLLM_BASE_URL=http://localhost:8000/v1
VLLM_MODEL=your-model-name
VLLM_API_KEY=your-key
```

로컬에 vLLM/OpenAI 호환 서버가 없으면, 테스트는 **4단계 상태 확인**까지만 진행할 수 있습니다.

---

## 4. 상태 확인만 먼저 (LLM 불필요)

RE 세션이 있는지, 스캔 없이 상태만 볼 때:

```bash
npm run re-scan -- --status
```

아직 한 번도 스캔하지 않았다면 `No RE sessions found.` 가 나오면 정상입니다.

---

## 5. Phase 1만 테스트 (re-inventory)

시스템에 있는 ELF 바이너리 하나로 **인벤토리 에이전트만** 실행합니다.

```bash
# curl 바이너리로 re-inventory만 실행
npm run re-scan -- /usr/bin/curl --config configs/binary/sample-re.yaml --agent re-inventory
```

- **설정 파일**: `configs/binary/sample-re.yaml` 에 MCP 서버(re-sigcheck 등) 정의가 있어야 합니다.
- **바이너리**: `/usr/bin/curl` 대신 `/bin/ls`, `/usr/bin/wget` 등 존재하는 ELF 경로로 바꿔도 됩니다.

실행 후:

- `repos/re-curl/` (또는 사용한 바이너리 이름 기준) 워크스페이스가 생깁니다.
- `repos/re-curl/deliverables/re_inventory_deliverable.md` 가 생성되면 Phase 1 성공입니다.

**DiE(diec) 없이** 실행하면 `file` + `readelf` 기반 `sigcheck_analyze`만 동작하고, `die_scan` / `binary_info` 호출은 실패할 수 있습니다. 인벤토리 자체는 완료될 수 있으니, 우선 이렇게 한 번 돌려보면 됩니다.

---

## 6. 다시 상태 확인

한 번이라도 스캔을 돌렸다면:

```bash
npm run re-scan -- --status
```

- 진행률(예: 1/6 agents)
- Phase별 에이전트 상태(✅/⏳/❌/⏸️)
- `deliverables/` 파일 목록

을 확인할 수 있습니다.

---

## 7. (선택) Phase 2 이상 테스트

- **Phase 2 (정적 분석)**: Ghidra + bethington/ghidra-mcp 필요. WSL2에서는 Xvfb/GUI 이슈로 불안정할 수 있어, **Ubuntu GUI 서버**에서 하는 것을 권장합니다.
- **Phase 3 (동적)**: `strace`, `gdb`, `frida` 설치 필요.
- **Phase 4 (네트워크)**: `tshark` 설치 및 캡처 권한 필요.

WSL2에서 Phase 1만 안정적으로 돌리면, re-scanner·세션·상태 확인 흐름은 검증된 것으로 보면 됩니다.

---

## 요약 체크리스트

| 단계 | 명령 | 비고 |
|------|------|------|
| 1 | `node --version`, `file --version`, `readelf --version` | 18+, 있음 |
| 2 | `npm run build` + `mcp-servers/re-sigcheck-mcp` npm install | Phase 1용 |
| 3 | `.env` 에 VLLM_BASE_URL, VLLM_MODEL 등 설정 | LLM 테스트용 |
| 4 | `npm run re-scan -- --status` | RE 세션 없으면 "No RE sessions" |
| 5 | `npm run re-scan -- /usr/bin/curl --config configs/binary/sample-re.yaml --agent re-inventory` | Phase 1만 실행 |
| 6 | `npm run re-scan -- --status` | 진행률·deliverables 확인 |

이 순서대로 하면 WSL2 Ubuntu에서 re-scanner를 최소한으로 시작할 수 있습니다.
