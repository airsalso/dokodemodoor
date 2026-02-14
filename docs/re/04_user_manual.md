# DokodemoDoor Reverse Engineering Scanner 사용자 메뉴얼

> 버전: 1.2 (Phase 4 — 전 Phase 코드 구현 완료)
> 작성일: 2026-02-13
> 최종 수정: 2026-02-13

---

## 목차

1. [개요](#1-개요)
2. [사전 요구사항](#2-사전-요구사항)
3. [설치 및 설정](#3-설치-및-설정)
4. [빠른 시작](#4-빠른-시작)
5. [CLI 사용법](#5-cli-사용법)
6. [설정 파일 작성](#6-설정-파일-작성)
7. [MCP 서버 설정](#7-mcp-서버-설정)
8. [분석 파이프라인 상세](#8-분석-파이프라인-상세)
9. [산출물(Deliverables) 가이드](#9-산출물deliverables-가이드)
10. [실행 예시](#10-실행-예시)
11. [트러블슈팅](#11-트러블슈팅)
12. [FAQ](#12-faq)

---

## 1. 개요

DokodemoDoor RE Scanner는 PE/ELF 바이너리의 리버스 엔지니어링 분석을 자동화하는 AI 에이전트 기반 도구입니다.
DokodemoDoor는 Ubuntu에서 실행되며, PE (Windows)와 ELF (Linux) 바이너리 모두를 분석 대상으로 지원합니다.

### 분석 파이프라인

```
Phase 1: Pre-Inventory   → 바이너리 서명/패킹/컴파일러 식별
Phase 2: Static Analysis  → Ghidra 기반 정적 분석 + 관찰 후보 추출
Phase 3: Dynamic Obs.     → strace/gdb 동적 관찰 + Frida 계측 (병렬)
Phase 4: Network Analysis  → tshark 네트워크 트래픽 분석
Phase 5: RE Reporting      → 종합 분석 보고서 생성
```

### 사용 가능 범위 (전 Phase 코드 구현 완료)

- **Phase 1**: Sigcheck(디지털 서명) + DiE(패킹/컴파일러 탐지)
- **Phase 2**: Ghidra 정적 분석 (bethington/ghidra-mcp 110개 도구)
- **Phase 3**: strace/gdb 동적 관찰 + Frida 계측 (병렬)
- **Phase 4**: tshark 네트워크 트래픽 분석
- **Phase 5**: 분석 결과 종합 보고서

---

## 2. 사전 요구사항

### 2.1 필수 소프트웨어

| 소프트웨어 | 버전 | 용도 | Ubuntu 설치 |
|------------|------|------|-------------|
| **Node.js** | 18+ | 런타임 | `sudo apt install nodejs npm` |
| **Git** | 2.x+ | 체크포인트 | `sudo apt install git` |
| **Java (JDK)** | 21+ | Ghidra + GhidraMCP 빌드 | `sudo apt install openjdk-21-jdk` |
| **Maven** | 3.9+ | GhidraMCP 플러그인 빌드 | `sudo apt install maven` |
| **Python 3** | 3.8+ | MCP bridge | `sudo apt install python3 python3-pip` |
| **file + readelf** | (시스템 기본) | 바이너리 식별 (ELF/PE 공통) | Ubuntu 기본 포함 (`sudo apt install binutils`) |
| **Detect It Easy (DiE)** | 3.x+ CLI | 패킹 탐지 | [GitHub Releases](https://github.com/horsicq/DIE-engine/releases) |
| **Ghidra** | 12.0.2 | 정적 분석 | `/opt/ghidra` |
| **bethington/ghidra-mcp** | 2.0.0 | Ghidra MCP 플러그인 (110개 도구) | `/opt/ghidra-mcp` |

> **참고**: Xvfb는 GUI 없는 서버 환경에서만 필요합니다. Ubuntu Desktop 환경에서는 불필요합니다.

> **참고**: `sigcheck64`는 Windows 전용 도구입니다. Linux에서는 `file` + `readelf` + `sha256sum` 조합으로 동등한 기능을 제공하며, re-sigcheck-mcp가 플랫폼을 자동 감지하여 적절한 도구를 사용합니다.

### 2.2 file + readelf 설치 (Ubuntu)

Ubuntu에는 `file` 명령이 기본 설치되어 있습니다. `readelf`는 `binutils` 패키지에 포함됩니다:

```bash
# 대부분의 Ubuntu 설치에 이미 포함됨
sudo apt install binutils file
# 확인
file --version
readelf --version
```

### 2.3 Detect It Easy (DiE) CLI 설치

1. [DiE GitHub](https://github.com/horsicq/DIE-engine/releases) 에서 Linux CLI 버전(`die_xxx_Ubuntu_xxx`) 다운로드
2. 압축 해제 후 `diec`를 PATH에 추가하거나 설정에서 경로 지정

```bash
# 예시: DiE CLI 설치
wget https://github.com/horsicq/DIE-engine/releases/download/3.10/die_3.10_Ubuntu_24.04_amd64.deb
sudo dpkg -i die_3.10_Ubuntu_24.04_amd64.deb
# 또는 포터블 버전
tar xzf die_xxx_linux_portable.tar.gz -C /opt/die
export PATH="/opt/die:$PATH"
# 확인
diec --version
```

### 2.4 Ghidra + GhidraMCP 플러그인 설치 (자동)

**자동 설치 스크립트** (권장):

```bash
# 원클릭 설치: Ghidra 12.0.2 + bethington/ghidra-mcp + Python bridge
sudo bash scripts/setup-ghidra-mcp.sh
```

이 스크립트가 수행하는 작업:
1. 시스템 패키지 설치 (Maven, Xvfb, 폰트 라이브러리)
2. Ghidra 12.0.2 다운로드 및 `/opt/ghidra`에 설치
3. bethington/ghidra-mcp 클론, 빌드, 플러그인 배포
4. Python bridge 의존성 설치

**수동 설치**:

```bash
# 1. Java 21 설치
sudo apt install openjdk-21-jdk

# 2. Ghidra 12.0.2 설치
wget https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.0.2_build/ghidra_12.0.2_PUBLIC_20250206.zip
sudo unzip ghidra_12.0.2_PUBLIC_*.zip -d /opt/
sudo mv /opt/ghidra_12.0.2_PUBLIC /opt/ghidra

# 3. bethington/ghidra-mcp 빌드 및 배포
git clone https://github.com/bethington/ghidra-mcp.git /opt/ghidra-mcp
cd /opt/ghidra-mcp
# Ghidra JAR 라이브러리 복사 → Maven 빌드 → 플러그인 ZIP을 Ghidra Extensions에 복사
# (상세 절차: scripts/setup-ghidra-mcp.sh 참조)

# 4. Python bridge 의존성
pip3 install -r /opt/ghidra-mcp/requirements.txt

# 5. 환경변수 설정
echo 'export GHIDRA_HOME="/opt/ghidra"' >> ~/.bashrc
echo 'export GHIDRA_MCP_DIR="/opt/ghidra-mcp"' >> ~/.bashrc
```

### 2.5 Ghidra MCP 서비스 시작

설치 완료 후 Ghidra MCP 서비스를 시작합니다:

```bash
# 서비스 시작 (Xvfb + Ghidra + bridge)
bash scripts/start-ghidra-mcp.sh

# 상태 확인
bash scripts/start-ghidra-mcp.sh status

# 서비스 중지
bash scripts/start-ghidra-mcp.sh stop

# 재시작
bash scripts/start-ghidra-mcp.sh restart
```

> **Ubuntu Desktop 환경**: Ghidra GUI를 직접 실행해도 됩니다. `Tools > GhidraMCP > Start MCP Server`로 HTTP 서버를 시작하세요.

> **최초 실행 시**: Ghidra 기동 후 `Tools > GhidraMCP > Start MCP Server`를 수동으로 한 번 실행해야 할 수 있습니다. VNC로 확인: `x11vnc -display :99 -nopw -forever &` → VNC 클라이언트로 `localhost:5900` 접속.

### 2.6 LLM 설정

`.env` 파일에 LLM 제공자 설정 필요:

```env
DOKODEMODOOR_LLM_PROVIDER=vllm
VLLM_BASE_URL=http://localhost:8000/v1
VLLM_MODEL=your-model-name
VLLM_API_KEY=your-api-key
VLLM_MAX_TURNS=30
```

---

## 3. 설치 및 설정

### 3.1 프로젝트 설치

```bash
# 프로젝트 클론 후 의존성 설치
cd dokodemodoor
npm run build

# MCP 서버 의존성 설치 (전체)
cd mcp-servers/re-sigcheck-mcp && npm install && cd ../..
cd mcp-servers/re-ghidra-mcp && npm install && cd ../..
cd mcp-servers/re-procmon-mcp && npm install && cd ../..
cd mcp-servers/re-windbg-mcp && npm install && cd ../..
cd mcp-servers/re-frida-mcp && npm install && cd ../..
cd mcp-servers/re-tshark-mcp && npm install && cd ../..
```

### 3.2 환경 설정

`.env` 파일을 프로젝트 루트에 생성:

```env
# LLM 설정 (필수)
DOKODEMODOOR_LLM_PROVIDER=vllm
VLLM_BASE_URL=http://localhost:8000/v1
VLLM_MODEL=your-model
VLLM_API_KEY=your-key

# RE 도구 경로 (선택, 설정 파일에서도 지정 가능)
# Linux에서는 SIGCHECK_PATH 불필요 (file+readelf 자동 사용)
DIE_PATH=diec
GHIDRA_HOME=/opt/ghidra
GHIDRA_MCP_DIR=/opt/ghidra-mcp
GHIDRA_MCP_HTTP_PORT=8080

# 디버그 (선택)
DOKODEMODOOR_DEBUG=false
DOKODEMODOOR_AGENT_DEBUG_LOG=true
```

### 3.3 설정 검증

```bash
# 도구 가용성 확인 (Ubuntu)
file --version
readelf --version
diec --version
java --version         # 21+ 필요
mvn --version          # 3.9+ 필요

# Ghidra 확인
ls "$GHIDRA_HOME/ghidraRun"

# Ghidra MCP 서비스 상태 확인
bash scripts/start-ghidra-mcp.sh status

# HTTP 헬스체크
curl -sf http://127.0.0.1:8080/check_connection && echo "OK" || echo "NOT RUNNING"
```

---

## 4. 빠른 시작

가장 빠르게 RE 분석을 실행하는 방법:

```bash
# 1. 설정 파일 없이 바로 실행 (기본 설정 사용)
npm run re-scan -- "/path/to/target/sample-app"

# 2. 설정 파일과 함께 실행 (권장)
npm run re-scan -- "/path/to/target/sample-app" --config configs/profile/sample-re.yaml

# 3. PE 바이너리 분석 (Linux에서 Windows 바이너리 분석 가능)
npm run re-scan -- "/path/to/target/sample-app.exe" --config configs/profile/sample-re.yaml
```

실행 결과:
- 작업 디렉토리: `repos/re-sample-app/`
- 산출물 디렉토리: `repos/re-sample-app/deliverables/`
- 세션 기록: `sessions/`

---

## 5. CLI 사용법

### 5.1 기본 문법

```
node re-scanner.mjs <binary_path> [options]
```

또는:

```
npm run re-scan -- <binary_path> [options]
```

### 5.2 인자 및 옵션

| 인자/옵션 | 필수 | 설명 | 예시 |
|-----------|------|------|------|
| `<binary_path>` | (실행 시) | 분석 대상 바이너리 경로 | `"/path/to/target/app"` |
| `--config <path>` | 선택 | YAML 설정 파일 | `--config configs/profile/sample-re.yaml` |
| `--phase <name>` | 선택 | 특정 phase만 실행 | `--phase re-static-analysis` |
| `--agent <name>` | 선택 | 특정 agent만 실행 | `--agent re-inventory` |
| `--status [id]` | - | RE 세션 상태 조회 (전체 또는 세션 ID/접두사) | `--status` 또는 `--status a1b2c3d4` |
| `--help`, `-h` | - | 도움말 출력 | - |

**상태 확인**: `re-scanner.mjs` 실행 후 진행 상황을 보려면 `--status` 옵션을 사용합니다. 바이너리 경로 없이 호출합니다.

```bash
# 모든 RE 세션 상태 출력
npm run re-scan -- --status

# 특정 세션만 조회 (세션 ID 전체 또는 앞 8자)
npm run re-scan -- --status a1b2c3d4
```

출력 내용: 대상 바이너리, 워크스페이스 경로, 세션 ID, 진행률(완료 에이전트 수/전체), Phase별 에이전트 상태(✅ COMPLETED / ⏳ RUNNING / ❌ FAILED / ⏸️ PENDING), `deliverables/` 디렉토리 파일 목록.

**세션 정리(cleanup)**: RE 세션 삭제는 **re-scanner.mjs --cleanup**으로 합니다 (웹 펜테스트용 `dokodemodoor.mjs --cleanup`과 동일 스토어를 사용하지만, RE 작업은 한 곳에서 처리하는 것이 맞습니다).

```bash
# 특정 RE 세션 삭제 (세션 ID 전체 또는 앞 8자)
npm run re-scan -- --cleanup 13e0904d

# 모든 RE 세션 삭제 (확인 후)
npm run re-scan -- --cleanup
```

**작업 중단 후 세션 상태 정리 (프론트엔드 STOP)**: 프론트엔드에서 re-scanner 프로세스를 SIGKILL 등으로 강제 종료하면, 프로세스 내부의 시그널 핸들러가 실행되지 않아 세션이 `running` 상태로 남을 수 있습니다. **백엔드에서 대응 가능**합니다. 프로세스를 종료한 뒤, 같은 머신에서 아래 명령을 한 번 더 실행하면 됩니다.

```bash
# running 상태인 RE 세션 전부 interrupted 로 마킹
npm run re-scan -- --mark-interrupted

# 특정 세션만 마킹 (세션 ID를 알고 있을 때)
npm run re-scan -- --mark-interrupted 13e0904d
```

프론트엔드 구현 제안: 사용자가 [STOP] 클릭 시 (1) 프로세스 트리 kill 후 (2) `node re-scanner.mjs --mark-interrupted` 를 실행하거나, 세션 ID를 알고 있으면 `--mark-interrupted <session_id>` 로 호출하면 됩니다. 별도 API가 없어도 됩니다.

**바이너리와 워크스페이스**: 업로드한 바이너리 경로(예: `/home/.../binary/regedit.exe`)는 원본 위치에 두고, **실행 시 워크스페이스(`repos/re-<이름>/`) 안에 복사**됩니다. MCP 도구(bash, read_file 등)는 project root = 워크스페이스만 허용하므로, 에이전트에게는 **워크스페이스 내 바이너리 경로**가 전달되어 샌드박스 안에서 접근할 수 있습니다. 같은 바이너리를 다시 실행하면 수정 시각이 새로울 때만 덮어씁니다.

### 5.3 실행 모드

#### 전체 파이프라인 실행

```bash
npm run re-scan -- "/path/to/target/app" --config configs/profile/my-target.yaml
```

#### 특정 Phase만 실행

```bash
# Pre-Inventory만 실행
npm run re-scan -- "/path/to/target/app" --phase re-inventory

# Static Analysis만 실행 (re-inventory 완료 필요)
npm run re-scan -- "/path/to/target/app" --phase re-static-analysis
```

#### 특정 Agent만 실행

```bash
# re-inventory agent만 실행
npm run re-scan -- "/path/to/target/app" --agent re-inventory

# re-static agent만 실행
npm run re-scan -- "/path/to/target/app" --agent re-static
```

### 5.4 Phase 이름 목록

| Phase 이름 | 포함 Agent | 설명 |
|------------|-----------|------|
| `re-inventory` | re-inventory | 바이너리 사전 인벤토리 |
| `re-static-analysis` | re-static | Ghidra 정적 분석 |
| `re-dynamic-observation` | re-dynamic, re-instrument | 동적 관찰 (예정) |
| `re-network-analysis` | re-network | 네트워크 분석 (예정) |
| `re-reporting` | re-report | 종합 보고서 |

### 5.5 Agent 이름 목록

| Agent 이름 | Phase | MCP 서버 | 상태 |
|------------|-------|----------|------|
| `re-inventory` | re-inventory | re-sigcheck | 구현 완료 |
| `re-static` | re-static-analysis | re-ghidra (bethington/ghidra-mcp 110개 도구) | 구현 완료 |
| `re-dynamic` | re-dynamic-observation | re-procmon + re-windbg | 구현 완료 |
| `re-instrument` | re-dynamic-observation | re-frida | 구현 완료 |
| `re-network` | re-network-analysis | re-tshark | 구현 완료 |
| `re-report` | re-reporting | dokodemodoor-helper | 구현 완료 |

---

## 6. 설정 파일 작성

### 6.1 YAML 설정 구조

```yaml
# configs/profile/my-target.yaml

reverse_engineering:
  # 분석 대상 바이너리 경로 (필수)
  binary_path: "/path/to/target/my-app"     # ELF
  # binary_path: "/path/to/target/my-app.exe"  # PE도 가능

  # 디버그 심볼 경로 (선택)
  # PDB (Windows) 또는 별도 DWARF 디버그 심볼 파일 (Linux)
  symbols_path: "/path/to/target/my-app.debug"

  # 동적 분석 시 프로세스 이름 (선택, 기본: 바이너리 파일명)
  process_name: "my-app"

  # 프로세스 실행 인자 (선택)
  launch_args: ["--debug", "--verbose"]

  # 분석 초점 카테고리 (선택)
  # 가능한 값: network, authentication, cryptography, license,
  #            update, anti-tamper, file-io, registry
  analysis_focus:
    - network
    - authentication
    - cryptography

  # 네트워크 캡처 인터페이스 (선택)
  network_interface: "eth0"

  # 기존 Ghidra 프로젝트 경로 (선택)
  # ghidra_project: "/opt/ghidra-projects/my-app"

# MCP 서버 설정
mcpServers:
  re-sigcheck:
    type: stdio
    command: node
    args: ["./mcp-servers/re-sigcheck-mcp/index.js"]
    env:
      # Linux에서는 SIGCHECK_PATH 불필요 (file+readelf 자동 사용)
      DIE_PATH: "diec"
  re-ghidra:
    type: stdio
    command: node
    args: ["./mcp-servers/re-ghidra-mcp/bridge-wrapper.js"]
    env:
      GHIDRA_MCP_DIR: "/opt/ghidra-mcp"
      GHIDRA_MCP_HTTP_PORT: "8080"
```

### 6.2 analysis_focus 상세

| 값 | 설명 | 관련 함수 패턴 |
|----|------|----------------|
| `network` | 네트워크 통신 | WinHttp, WinInet, socket, WSA, connect, send, recv, curl_* |
| `authentication` | 인증/세션 | Login, Auth, Token, Credential, PAM_* |
| `cryptography` | 암호화/복호화 | Crypt, BCrypt, AES, RSA, SHA, EVP_*, SSL_* |
| `license` | 라이선스 검증 | License, Serial, Activate |
| `update` | 자동 업데이트 | Update, Download, Version |
| `anti-tamper` | 무결성 검증 | IsDebugger, ptrace, CRC, Checksum |
| `file-io` | 파일 I/O | CreateFile, ReadFile, WriteFile, open, read, write, fopen |
| `registry` | 레지스트리 (Windows) | RegOpen, RegCreate, RegQuery |

지정하지 않으면 기본값 `network, authentication, cryptography`가 사용됩니다.

### 6.3 최소 설정 파일

```yaml
# 최소 설정 (MCP 서버만 지정)
mcpServers:
  re-sigcheck:
    type: stdio
    command: node
    args: ["./mcp-servers/re-sigcheck-mcp/index.js"]
  re-ghidra:
    type: stdio
    command: node
    args: ["./mcp-servers/re-ghidra-mcp/bridge-wrapper.js"]
    env:
      GHIDRA_MCP_DIR: "/opt/ghidra-mcp"
      GHIDRA_MCP_HTTP_PORT: "8080"
```

---

## 7. MCP 서버 설정

### 7.1 MCP 서버 개요

RE Scanner는 MCP(Model Context Protocol) 서버를 통해 외부 분석 도구와 통신합니다.
각 분석 도구는 독립 MCP 서버로 래핑되어 stdio를 통해 연결됩니다.

```
RE Agent → MCP Proxy → MCP Server (stdio) → 외부 도구 (Sigcheck/Ghidra/...)
```

### 7.2 re-sigcheck MCP 서버

**위치**: `mcp-servers/re-sigcheck-mcp/`

**제공 도구**:

| 도구 | 파라미터 | 설명 |
|------|----------|------|
| `sigcheck_analyze` | `binary_path` (string) | 서명 검증 + 해시 추출 (sigcheck64 (Win) / file+readelf (Linux)) |
| `die_scan` | `binary_path` (string) | DiE로 패킹/컴파일러/런타임 탐지 |
| `binary_info` | `binary_path` (string) | PE/ELF 헤더 상세 정보 (deep scan) |

**환경변수**:

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `SIGCHECK_PATH` | (Windows 전용) | Sigcheck 실행 파일 경로. Linux에서는 불필요 (file+readelf 자동 사용) |
| `DIE_PATH` | `diec` | DiE CLI 실행 파일 경로 |

**단독 테스트**:

```bash
# MCP 서버 직접 실행 (stdio 통신)
cd mcp-servers/re-sigcheck-mcp
npm install
node index.js
# JSON-RPC로 도구 호출 가능
```

### 7.3 re-ghidra MCP 서버 (bethington/ghidra-mcp 기반)

**위치**: `mcp-servers/re-ghidra-mcp/bridge-wrapper.js`
**백엔드**: [bethington/ghidra-mcp](https://github.com/bethington/ghidra-mcp) — Ghidra GUI Plugin + Python bridge

**아키텍처**:
```
bridge-wrapper.js (Node.js, stdio MCP)
  → bridge_mcp_ghidra.py (Python, MCP ↔ HTTP 변환)
    → Ghidra GUI + GhidraMCP Plugin (HTTP :8080)
```

**제공 도구 (110개)** — 주요 도구:

| 카테고리 | 도구 | 설명 |
|----------|------|------|
| 핵심 | `check_connection` | Ghidra MCP 서버 연결 확인 |
| 핵심 | `get_metadata` | 바이너리 메타데이터 |
| 핵심 | `list_functions` | 전체 함수 목록 (페이지네이션) |
| 핵심 | `search_functions_by_name` | 함수 이름/패턴 검색 |
| 핵심 | `decompile_function` | 함수 디컴파일 (C 의사코드) |
| 핵심 | `list_imports` / `list_exports` | Import/Export 심볼 |
| 핵심 | `list_strings` | 문자열 추출 및 분류 |
| 핵심 | `get_xrefs_to` / `get_xrefs_from` | 교차참조 |
| 콜그래프 | `get_function_callers` / `get_function_callees` | 호출 관계 |
| 콜그래프 | `get_function_call_graph` | 함수 콜그래프 |
| 콜그래프 | `analyze_function_complete` | 종합 분석 (디컴파일+xref+변수 일괄) |
| 메모리 | `list_segments` | 메모리 세그먼트 레이아웃 |
| 메모리 | `disassemble_function` | 어셈블리 디스어셈블리 |
| 메모리 | `search_byte_patterns` | 바이트 시그니처 검색 |
| 배치 | `get_bulk_xrefs` | 다수 주소 교차참조 일괄 조회 |
| 배치 | `batch_rename_function_components` | 함수+변수+주석 일괄 변경 |
| 문서화 | `rename_function` | 함수 리네이밍 |
| 문서화 | `set_decompiler_comment` | 디컴파일러 주석 |
| 구조체 | `create_struct` / `add_struct_field` | 구조체 생성/수정 |

> 전체 110개 도구 목록: [bethington/ghidra-mcp README](https://github.com/bethington/ghidra-mcp)

**환경변수**:

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `GHIDRA_MCP_DIR` | `/opt/ghidra-mcp` | bethington/ghidra-mcp 설치 디렉토리 |
| `GHIDRA_MCP_HTTP_PORT` | `8080` | Ghidra MCP Plugin HTTP 포트 |

**사전 조건**:
- Ghidra MCP 서비스가 실행 중이어야 합니다 (`bash scripts/start-ghidra-mcp.sh`)
- Ghidra에서 분석할 바이너리를 로드해야 합니다 (에이전트가 자동 수행)
- `check_connection`으로 연결 상태를 먼저 확인합니다

### 7.4 MCP 설정 참조 파일

전체 MCP 서버 설정 예시: `configs/mcp/re-tools.json`

이 파일은 MVP 서버(re-sigcheck, re-ghidra) 외에 향후 구현될 서버(re-windbg, re-procmon, re-frida, re-tshark)의 설정 템플릿도 포함합니다.

---

## 8. 분석 파이프라인 상세

### 8.1 Phase 1: Pre-Inventory (re-inventory)

**목적**: 바이너리의 기본 속성을 파악하여 후속 분석 방향을 결정합니다.

**사용 도구**: re-sigcheck MCP (sigcheck_analyze, die_scan, binary_info)

**분석 항목**:
1. 디지털 서명 유무 및 유효성 (PE: Authenticode / ELF: N/A)
2. 서명자(Publisher) 정보 (PE) 또는 빌드 정보 (ELF)
3. 컴파일러/링커 식별 (MSVC, GCC, Clang, Delphi, .NET 등)
4. 패커/프로텍터 탐지 (UPX, Themida, VMProtect 등)
5. 런타임 환경 (Native, .NET CLR, Java 등)
6. 바이너리 아키텍처 (x86/x64/ARM)
7. Import 라이브러리 분류 (PE: Import DLL / ELF: 공유 라이브러리)

**산출물**: `re_inventory_deliverable.md`

### 8.2 Phase 2: Static Analysis (re-static)

**목적**: Ghidra를 사용하여 바이너리의 내부 구조를 분석하고, 동적 관찰 대상을 추출합니다.

**사용 도구**: re-ghidra MCP (bethington/ghidra-mcp 110개 도구)

**분석 흐름**:
1. 연결 확인 (`check_connection`) + 메타데이터 수집 (`get_metadata`, `get_entry_points`)
2. Import/Export/문자열 분석 (`list_imports`, `list_exports`, `list_strings`)
3. 함수 검색 (`search_functions_by_name`, `search_functions_enhanced`) — analysis_focus 기반
4. 핵심 함수 종합 분석 (`analyze_function_complete`) — 디컴파일+xref+변수 일괄
5. 콜그래프 추적 (`get_function_call_graph`) — 호출 체인 발견
6. 배치 교차참조 조회 (`get_bulk_xrefs`) — 다수 함수 일괄 분석
7. (선택적) 분석 결과 반영 (`rename_function`, `set_decompiler_comment`, `batch_rename_function_components`)

**산출물**:
- `re_static_analysis_deliverable.md` — 정적 분석 보고서
- `re_observation_candidates.json` — 동적 관찰 후보 (Phase 3 입력)

### 8.3 Phase 3: Dynamic Observation (re-dynamic + re-instrument)

**목적**: 바이너리 실행 중 행위를 관찰하고 런타임 데이터를 수집합니다.

**에이전트** (병렬 실행):

#### re-dynamic — 시스템 콜 관찰 + 디버거
**사용 도구**: re-procmon MCP (strace) + re-windbg MCP (gdb)

| 도구 | 설명 |
|------|------|
| `procmon_start_capture` | strace 캡처 시작 (file/network/process/memory/signal 필터) |
| `procmon_stop_capture` | 캡처 중지 + 요약 통계 |
| `procmon_get_events` | 캡처 이벤트 조회 (syscall/경로/PID 필터링) |
| `procmon_set_filter` | 필터 프리셋 조회/커스텀 필터 생성 |
| `cdb_attach_process` | gdb를 프로세스에 연결 |
| `cdb_run_command` | 디버거 명령 실행 |
| `cdb_set_breakpoint` | 브레이크포인트 설정 (조건부, 명령 자동 실행) |
| `cdb_list_modules` | 로드된 공유 라이브러리 목록 |
| `cdb_list_threads` | 스레드 목록 + 백트레이스 |
| `cdb_list_exceptions` | 예외/시그널 이벤트 |
| `cdb_capture_crash` | 크래시 덤프 + 레지스터 + 콜스택 |

**분석 흐름**: 관찰 계획 수립 → strace 다회 캡처 (필터 변경) → gdb 심층 관찰 (선택적) → 교차 분석

**산출물**: `re_dynamic_observation_deliverable.md`, `re_behavioral_log.json`

#### re-instrument — Frida 런타임 계측
**사용 도구**: re-frida MCP

| 도구 | 설명 |
|------|------|
| `frida_attach` | 프로세스에 Frida 연결 |
| `frida_hook_function` | 함수 훅 설치 (인자/반환값/콜스택 로깅) |
| `frida_list_modules` | 로드된 모듈 목록 |
| `frida_list_exports` | 특정 모듈의 export 함수 |
| `frida_inject_script` | 커스텀 JavaScript 스크립트 삽입 |
| `frida_get_logs` | 수집된 훅 로그 조회 (필터/제한) |
| `frida_unhook` | 설치된 훅 제거 / Frida 분리 |

**분석 흐름**: observation_candidates 기반 훅 계획 → Frida 연결 → 자동 훅 설치 → 로그 수집·분석 → 커스텀 스크립트 (선택)

**산출물**: `re_instrumentation_deliverable.md`, `re_hook_logs.json`

### 8.4 Phase 4: Network Analysis (re-network)

**목적**: 바이너리의 네트워크 통신 패턴을 분석합니다.

**사용 도구**: re-tshark MCP

| 도구 | 설명 |
|------|------|
| `tshark_start_capture` | 네트워크 캡처 시작 (인터페이스, BPF 필터, 시간/패킷 제한) |
| `tshark_stop_capture` | 캡처 중지 + PCAP 통계 요약 |
| `tshark_analyze_capture` | PCAP 분석 (summary/protocols/endpoints/conversations/expert) |
| `tshark_get_http_streams` | HTTP 요청/응답 스트림 추출 |
| `tshark_get_dns_queries` | DNS 쿼리/응답 추출 + 도메인 집계 |
| `tshark_get_tls_handshakes` | TLS Client Hello 추출 (SNI, 버전, 암호 스위트) |

**분석 흐름**: 이전 단계 결과 기반 캡처 전략 → 다회 캡처 (전체→집중→특수) → 6개 분석 단계 → 보안 판단 + 교차 검증

**산출물**: `re_network_analysis_deliverable.md`, `re_network_sessions.json`

### 8.5 Phase 5: RE Reporting (re-report)

**목적**: 모든 분석 결과를 종합하여 최종 보고서를 생성합니다.

**산출물**: `re_comprehensive_report.md`

보고서 구조:
- Executive Summary
- 바이너리 프로필 (인벤토리 결과)
- 정적 분석 결과
- 동적 관찰 결과 (Phase 3 완료 시)
- 네트워크 분석 결과 (Phase 4 완료 시)
- 관찰 결과 종합
- 재현 절차
- 결론 및 권고사항

---

## 9. 산출물(Deliverables) 가이드

### 9.1 산출물 목록

모든 산출물은 `repos/re-{binary-name}/deliverables/` 디렉토리에 저장됩니다.

| 파일명 | 타입 | Phase | 설명 |
|--------|------|-------|------|
| `re_inventory_deliverable.md` | Markdown | 1 | 바이너리 인벤토리 보고서 |
| `re_static_analysis_deliverable.md` | Markdown | 2 | 정적 분석 보고서 |
| `re_observation_candidates.json` | JSON | 2 | 동적 관찰 후보 목록 |
| `re_dynamic_observation_deliverable.md` | Markdown | 3 | 동적 관찰 보고서 (예정) |
| `re_behavioral_log.json` | JSON | 3 | ProcMon 행위 로그 (예정) |
| `re_instrumentation_deliverable.md` | Markdown | 3 | Frida 계측 보고서 (예정) |
| `re_hook_logs.json` | JSON | 3 | Frida 훅 로그 (예정) |
| `re_network_analysis_deliverable.md` | Markdown | 4 | 네트워크 분석 보고서 (예정) |
| `re_network_sessions.json` | JSON | 4 | 네트워크 세션 데이터 (예정) |
| `re_comprehensive_report.md` | Markdown | 5 | 종합 분석 보고서 |

### 9.2 observation_candidates.json 구조

Phase 2에서 생성되어 Phase 3의 입력으로 사용되는 핵심 데이터:

```json
{
  "binary": "sample-app",
  "binary_format": "ELF",
  "analysis_timestamp": "2026-02-13T10:00:00Z",
  "total_candidates": 3,
  "candidates": [
    {
      "id": "candidate_001",
      "category": "network",
      "function_name": "connect",
      "module": "libc.so.6",
      "address": "0x00401234",
      "evidence": "Cross-ref from sub_401000, string ref 'https://api.example.com'",
      "priority": "high",
      "suggested_hooks": ["entry_args", "return_value", "callstack"],
      "decompile_summary": "소켓 연결을 수행하여 원격 서버 통신"
    }
  ]
}
```

### 9.3 산출물 확인

분석 완료 후 산출물 디렉토리를 확인합니다:

```bash
# 산출물 목록 확인
ls -la repos/re-sample-app/deliverables/

# 인벤토리 보고서 열기
cat repos/re-sample-app/deliverables/re_inventory_deliverable.md

# 종합 보고서 열기
cat repos/re-sample-app/deliverables/re_comprehensive_report.md
```

---

## 10. 실행 예시

### 10.1 기본 전체 파이프라인

```bash
# 설정 파일 준비
cp configs/profile/sample-re.yaml configs/profile/my-target.yaml
# (my-target.yaml 편집 -- binary_path, 도구 경로 등)

# 전체 파이프라인 실행
npm run re-scan -- "/path/to/target/my-app" --config configs/profile/my-target.yaml
```

**예상 출력**:

```
🔬 DOKODEMODOOR REVERSE ENGINEERING SCANNER
📦 Binary: /path/to/target/my-app
📂 Workspace: /home/user/dokodemodoor/repos/re-my-app
📝 Session created: a1b2c3d4...
   Analysis focus: network, authentication, cryptography

🔬 REVERSE ENGINEERING ANALYSIS PIPELINE

📋 RE Phase: re-inventory
   🤖 Running RE Pre-Inventory agent...
   ✅ re-inventory completed (45.2s)

📋 RE Phase: re-static-analysis
   🤖 Running RE Static Analysis agent...
   ✅ re-static completed (180.5s)

📋 RE Phase: re-reporting
   🤖 Running RE Report agent...
   ✅ re-report completed (60.3s)

✨ Reverse engineering analysis completed!
   Deliverables saved in: /home/user/dokodemodoor/repos/re-my-app/deliverables
   Completed agents: re-inventory, re-static, re-report

⏱️  Total execution time: 286.0s
```

### 10.2 인벤토리만 실행

```bash
npm run re-scan -- "/path/to/target/suspicious" --agent re-inventory
```

바이너리의 서명/패킹/컴파일러 정보만 빠르게 확인할 때 유용합니다.

### 10.3 정적 분석만 실행

```bash
# re-inventory가 먼저 완료되어 있어야 함
npm run re-scan -- "/path/to/target/my-app" --agent re-static
```

### 10.4 설정 파일 없이 실행

```bash
# 기본 설정으로 실행 (도구가 PATH에 있어야 함)
npm run re-scan -- "/path/to/target/app"
```

이 경우:
- Linux: `file`+`readelf`는 기본 설치, DiE(`diec`)는 시스템 PATH에서 검색
- Ghidra는 `GHIDRA_HOME` 환경변수 사용
- analysis_focus 기본값: `network, authentication, cryptography`

---

## 11. 트러블슈팅

### 11.1 "Binary not found" 오류

```
❌ Binary not found: /path/to/target/app
```

**원인**: 지정된 경로에 바이너리가 존재하지 않음
**해결**: 바이너리 경로를 절대 경로로 정확히 지정. 공백이 포함된 경로는 큰따옴표로 감싸기.

### 11.2 file/readelf 실행 실패 (Linux)

```
Binary info failed: spawn readelf ENOENT
```

**원인**: `readelf`가 설치되지 않음
**해결**:
```bash
sudo apt install binutils
which readelf
```

> **참고**: Windows에서 실행 시 `sigcheck64`를 사용합니다. Linux에서는 `file`+`readelf` 조합이 자동으로 사용됩니다.

### 11.3 DiE 실행 실패

```
DiE scan failed: spawn diec ENOENT
```

**원인**: `diec`가 PATH에 없음
**해결**: DiE CLI Linux 버전을 설치하고 경로 지정
```bash
which diec
# 경로가 나오지 않으면 DIE_PATH 환경변수 또는 설정 파일에서 절대 경로 지정
```

### 11.4 "Permission Denied: Access outside project root" (bash/파일 도구)

에이전트 로그에 다음과 같이 나올 수 있음:

```
Command failed: Permission Denied: Access outside project root is not allowed.
```

**원인**: MCP의 bash·read_file·search_file 등은 **project root = RE 워크스페이스(`repos/re-<이름>/`)** 안만 접근 가능함. 바이너리가 원본 경로(예: `/home/.../binary/regedit.exe`)에만 있고 워크스페이스 밖에 있으면, 에이전트가 해당 경로를 나열·접근하려 할 때 위 오류가 발생함.

**해결**: re-scanner는 실행 시 **대상 바이너리를 워크스페이스에 자동 복사**하므로, 최신 버전 사용 시에는 이 오류가 나지 않아야 함. 프롬프트에 전달되는 바이너리 경로도 워크스페이스 내 경로로 통일되어, re-sigcheck 등 도구가 샌드박스 안에서 접근할 수 있음.

### 11.5 Ghidra MCP 서비스 연결 실패

```
Bridge error: connect ECONNREFUSED 127.0.0.1:8080
```

**원인**: Ghidra MCP 서비스가 실행 중이지 않거나 플러그인이 시작되지 않음
**해결**:
```bash
# 서비스 상태 확인
bash scripts/start-ghidra-mcp.sh status

# 서비스가 중지되어 있으면 시작
bash scripts/start-ghidra-mcp.sh start

# Ghidra는 실행 중이나 HTTP 응답이 없는 경우
# → Ghidra GUI에서 Tools > GhidraMCP > Start MCP Server 수동 실행
# VNC로 확인: x11vnc -display :99 -nopw -forever &
```

### 11.6 Ghidra 분석 타임아웃

**원인**: 대형 바이너리에서 Ghidra 분석이 오래 걸림
**해결**:
1. 기존 Ghidra 프로젝트가 있으면 `ghidra_project` 설정으로 지정 (재분석 생략)
2. 바이너리 크기가 매우 큰 경우 Ghidra GUI에서 먼저 수동 분석 후 프로젝트 경로 지정

### 11.7 Prerequisites 미충족

```
⏭️ Skipping re-static: prerequisite re-inventory not completed
```

**원인**: 선행 에이전트가 완료되지 않은 상태에서 후속 에이전트 실행 시도
**해결**: 선행 에이전트부터 순서대로 실행하거나, 전체 파이프라인으로 실행

### 11.8 세션/체크포인트 오류

**원인**: 이전 실행에서 비정상 종료된 세션 잔여
**해결**:
```bash
# 작업 디렉토리 정리
rm -rf repos/re-my-app
# 세션 파일 정리 (해당 세션만)
rm -f sessions/*re*.json
# 다시 실행
npm run re-scan -- "/path/to/target/my-app" --config ...
```

### 11.9 LLM 연결 실패

**원인**: vLLM/OpenAI 엔드포인트에 연결할 수 없음
**해결**: `.env`의 `VLLM_BASE_URL`, `VLLM_API_KEY` 확인

---

## 12. FAQ

### Q: 어떤 바이너리 형식을 지원하나요?

MVP에서 **PE (Windows exe/dll)** 와 **ELF (Linux)** 바이너리 모두를 지원합니다.
- **PE**: sigcheck64 (Windows) 또는 file+readelf (Linux에서 PE 분석) + DiE + Ghidra
- **ELF**: file + readelf + DiE + Ghidra
- Ghidra는 Mach-O도 정적 분석 가능하나, macOS 바이너리 전용 인벤토리 도구는 향후 지원 예정입니다.

### Q: .NET 바이너리도 분석 가능한가요?

`re-inventory`에서 .NET 런타임으로 식별은 가능합니다. 그러나 현재 Ghidra 기반 정적 분석은 네이티브 바이너리에 최적화되어 있습니다. .NET 전용 분석(dnSpy/ILSpy CLI)은 향후 개발 예정입니다.

### Q: 분석 중 바이너리를 수정하나요?

아닙니다. RE Scanner는 **관찰 중심(Observation-Only)** 원칙을 따릅니다.
바이너리를 수정, 패치, 언패킹하지 않으며 읽기 전용으로 분석합니다.

### Q: 동적 분석(Phase 3, 4)은 사용 가능한가요?

Phase 3(strace + gdb + Frida)과 Phase 4(tshark) MCP 서버 및 프롬프트는 모두 구현 완료되었습니다. 운영 환경(Ubuntu GUI)에서 E2E 테스트 후 본격 사용 가능합니다. 동적 분석에는 `strace`, `gdb`, `frida`, `tshark` 도구가 시스템에 설치되어 있어야 합니다.

### Q: 이전 분석 결과를 이어서 사용할 수 있나요?

네. 작업 디렉토리(`repos/re-{name}/`)가 보존되어 있으면 `--phase` 또는 `--agent` 옵션으로 특정 단계만 재실행할 수 있습니다. git checkpoint 시스템이 각 에이전트 완료 시점을 기록합니다.

### Q: 웹 펜테스트와 동시에 실행할 수 있나요?

네. RE Scanner는 `re-scanner.mjs` 별도 엔트리포인트를 사용하므로 기존 `dokodemodoor.mjs` 웹 파이프라인과 독립적으로 실행됩니다. 세션도 별도로 관리됩니다.

### Q: 분석 시간은 얼마나 걸리나요?

바이너리 크기와 복잡도에 따라 다릅니다:
- Pre-Inventory: 30초 ~ 2분
- Static Analysis (Ghidra): 2분 ~ 10분+ (대형 바이너리)
- Reporting: 1분 ~ 3분
- MVP 전체 파이프라인: 약 5분 ~ 15분
