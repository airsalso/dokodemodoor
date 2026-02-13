# RE Pipeline 운영 환경 배포 가이드

> 작성일: 2026-02-13
> 대상 환경: Ubuntu GUI Desktop (사내 서버)
> 전제: 프로젝트 소스를 사내 서버에 수동 반입 완료

---

## 개요

이 문서는 DokodemoDoor RE 파이프라인을 사내 Ubuntu GUI 서버에 배포하고
전체 Phase(1~5) E2E 테스트를 수행하기 위한 단계별 절차입니다.

---

## 1. 시스템 요구사항 확인

```bash
# Ubuntu 버전 (22.04 LTS 이상 권장)
lsb_release -a

# GUI 환경 확인 (DISPLAY 변수가 설정되어 있어야 함)
echo $DISPLAY
# 예: :0 또는 :1

# 디스크 공간 (최소 10GB 여유 필요: Ghidra ~1GB, ghidra-mcp ~200MB, 런타임 데이터)
df -h /opt
```

---

## 2. 시스템 패키지 설치

```bash
# 기본 도구
sudo apt update && sudo apt install -y \
  nodejs npm \
  git \
  openjdk-21-jdk \
  maven \
  python3 python3-pip python3-venv \
  binutils file \
  strace gdb \
  tshark \
  curl wget unzip

# Node.js 18+ 확인 (Ubuntu 22.04 기본은 12.x이므로 별도 설치 필요할 수 있음)
node --version
# 18 미만이면:
# curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
# sudo apt install -y nodejs

# tshark 권한 설정 (비root 캡처 허용)
sudo setcap cap_net_raw+eip $(which tshark)
# 또는 설치 시 "Should non-superusers be able to capture packets?" → Yes 선택

# Java 21 확인
java --version   # openjdk 21.x.x

# Frida 설치 (pip)
pip3 install frida-tools
# frida-node는 npm install 시 자동 빌드됨 (빌드 도구 필요)
sudo apt install -y build-essential python3-dev
```

---

## 3. DiE (Detect It Easy) 설치

```bash
# 방법 1: deb 패키지 (Ubuntu 24.04)
wget https://github.com/horsicq/DIE-engine/releases/download/3.10/die_3.10_Ubuntu_24.04_amd64.deb
sudo dpkg -i die_3.10_Ubuntu_24.04_amd64.deb

# 방법 2: 포터블 (모든 Ubuntu 버전)
wget https://github.com/horsicq/DIE-engine/releases/download/3.10/die_3.10_Linux_x64.tar.gz
sudo mkdir -p /opt/die
sudo tar xzf die_3.10_Linux_x64.tar.gz -C /opt/die
sudo ln -sf /opt/die/diec /usr/local/bin/diec

# 확인
diec --version
```

---

## 4. Ghidra + bethington/ghidra-mcp 설치

### 방법 A: 자동 설치 (권장)

```bash
cd /path/to/dokodemodoor
sudo bash scripts/setup-ghidra-mcp.sh
```

### 방법 B: 수동 설치

```bash
# 4-1. Ghidra 12.0.2 설치
cd /tmp
wget https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.0.2_build/ghidra_12.0.2_PUBLIC_20250206.zip
sudo unzip ghidra_12.0.2_PUBLIC_*.zip -d /opt/
sudo mv /opt/ghidra_12.0.2_PUBLIC /opt/ghidra

# 4-2. bethington/ghidra-mcp 클론 및 빌드
sudo git clone https://github.com/bethington/ghidra-mcp.git /opt/ghidra-mcp
cd /opt/ghidra-mcp

# Ghidra JAR 라이브러리를 Maven 로컬 레포로 설치
# (setup-ghidra-mcp.sh의 install_ghidra_libs 함수 참조)
# GhidraGhidra 11.3.x 이상 JAR 파일들을 mvn install:install-file로 등록

# Maven 빌드
mvn clean package -DskipTests

# 플러그인 배포
PLUGIN_ZIP=$(find target -name "*.zip" | head -1)
GHIDRA_EXT="$HOME/.ghidra/.ghidra_12.0.2_PUBLIC/Extensions"
mkdir -p "$GHIDRA_EXT"
unzip "$PLUGIN_ZIP" -d "$GHIDRA_EXT/"

# 4-3. Python bridge 의존성
cd /opt/ghidra-mcp
pip3 install -r requirements.txt

# 4-4. 환경변수 설정
cat >> ~/.bashrc << 'EOF'
export GHIDRA_HOME="/opt/ghidra"
export GHIDRA_MCP_DIR="/opt/ghidra-mcp"
export PATH="$GHIDRA_HOME:$PATH"
EOF
source ~/.bashrc
```

---

## 5. Ghidra MCP 서비스 시작 (GUI 환경)

GUI 환경에서는 **두 가지 방법**이 있습니다:

### 방법 A: Ghidra GUI 직접 실행 (추천 — GUI 환경)

```bash
# 1. Ghidra 시작
/opt/ghidra/ghidraRun &

# 2. Ghidra GUI에서:
#    - 새 프로젝트 생성 또는 기존 프로젝트 열기
#    - 분석할 바이너리를 Import → 자동 분석 실행
#    - 메뉴: Tools → GhidraMCP → Start MCP Server
#    - HTTP 서버가 :8080에서 시작됨

# 3. 연결 확인
curl -sf http://127.0.0.1:8080/ && echo "Ghidra MCP OK"

# 4. Python bridge 시작 (별도 터미널)
cd /opt/ghidra-mcp
python3 bridge_mcp_ghidra.py --transport sse --ghidra-server http://127.0.0.1:8080/ &
```

### 방법 B: start-ghidra-mcp.sh 스크립트 (백그라운드/자동화)

```bash
# 서비스 시작 (Xvfb + Ghidra + bridge)
bash scripts/start-ghidra-mcp.sh start

# 상태 확인
bash scripts/start-ghidra-mcp.sh status

# VNC로 Ghidra GUI 확인 (원격에서)
x11vnc -display :99 -nopw -forever &
# → VNC 클라이언트로 <서버IP>:5900 접속
```

> **주의**: 최초 실행 시 Ghidra GUI에서 `Tools → GhidraMCP → Start MCP Server`를
> 수동으로 한 번 클릭해야 할 수 있습니다. VNC로 접속하여 확인하세요.

---

## 6. 프로젝트 의존성 설치

```bash
cd /path/to/dokodemodoor

# 메인 + MCP 서버 의존성
npm run build

# RE MCP 서버 의존성 (전체)
for dir in mcp-servers/re-*/; do
  echo "Installing: $dir"
  (cd "$dir" && npm install)
done

# re-frida-mcp의 frida 네이티브 모듈 빌드 확인
ls mcp-servers/re-frida-mcp/node_modules/frida/
```

---

## 7. 환경 설정

```bash
# .env 파일 생성/편집
cat >> .env << 'EOF'
# LLM 설정
DOKODEMODOOR_LLM_PROVIDER=vllm
VLLM_BASE_URL=http://localhost:8000/v1
VLLM_MODEL=your-model-name
VLLM_API_KEY=your-api-key
VLLM_MAX_TURNS=50

# RE 도구 경로
DIE_PATH=diec
GHIDRA_HOME=/opt/ghidra
GHIDRA_MCP_DIR=/opt/ghidra-mcp
GHIDRA_MCP_HTTP_PORT=8080

# 디버그
DOKODEMODOOR_DEBUG=true
DOKODEMODOOR_AGENT_DEBUG_LOG=true
EOF
```

---

## 8. 설정 검증 체크리스트

```bash
echo "=== 시스템 도구 ==="
node --version        # 18+
git --version         # 2.x
java --version        # 21+
python3 --version     # 3.8+

echo "=== RE 분석 도구 ==="
file --version        # OK
readelf --version     # OK (binutils)
diec --version        # 3.x
strace -V             # OK
gdb --version         # OK
tshark --version      # OK
frida --version       # OK (pip)

echo "=== Ghidra MCP ==="
ls "$GHIDRA_HOME/ghidraRun"
curl -sf http://127.0.0.1:8080/ && echo "Ghidra MCP: OK" || echo "Ghidra MCP: NOT RUNNING"

echo "=== MCP 서버 모듈 ==="
for dir in mcp-servers/re-*/; do
  if [ -d "$dir/node_modules" ]; then
    echo "✅ $dir"
  else
    echo "❌ $dir (npm install 필요)"
  fi
done
```

---

## 9. E2E 테스트 실행

### 9.1 Phase별 단계적 테스트

```bash
# 테스트 바이너리 준비 (예: curl)
TEST_BIN="/usr/bin/curl"
CONFIG="configs/profile/sample-re.yaml"

# Phase 1: Pre-Inventory 테스트
npm run re-scan -- "$TEST_BIN" --agent re-inventory --config "$CONFIG"
# → deliverables/re_inventory_deliverable.md 확인

# Phase 2: Static Analysis 테스트 (Ghidra MCP 서비스 실행 필수)
npm run re-scan -- "$TEST_BIN" --agent re-static --config "$CONFIG"
# → deliverables/re_static_analysis_deliverable.md 확인
# → deliverables/re_observation_candidates.json 확인

# Phase 3: Dynamic Observation 테스트
npm run re-scan -- "$TEST_BIN" --phase re-dynamic-observation --config "$CONFIG"
# → deliverables/re_dynamic_observation_deliverable.md 확인
# → deliverables/re_instrumentation_deliverable.md 확인

# Phase 4: Network Analysis 테스트
npm run re-scan -- "$TEST_BIN" --agent re-network --config "$CONFIG"
# → deliverables/re_network_analysis_deliverable.md 확인

# Phase 5: Report 테스트
npm run re-scan -- "$TEST_BIN" --agent re-report --config "$CONFIG"
# → deliverables/re_comprehensive_report.md 확인
```

### 9.2 전체 파이프라인 E2E

```bash
# 전체 파이프라인 한 번에 실행
npm run re-scan -- "$TEST_BIN" --config "$CONFIG"

# 산출물 확인
ls -la repos/re-curl/deliverables/
```

### 9.3 PE 바이너리 테스트

```bash
# Windows PE 바이너리를 Linux에서 분석 (Ghidra의 멀티포맷 지원)
npm run re-scan -- "/path/to/sample.exe" --config "$CONFIG"
```

---

## 10. 트러블슈팅

### Ghidra MCP Plugin이 자동 로드되지 않음

```bash
# 플러그인 설치 확인
ls ~/.ghidra/.ghidra_12.0.2_PUBLIC/Extensions/
# GhidraMCP 디렉토리가 있어야 함

# Ghidra 시작 후 File → Configure → Miscellaneous에서 GhidraMCP 활성화 확인
# 또는 File → Install Extensions에서 GhidraMCP가 체크되어 있는지 확인
```

### tshark 권한 오류

```bash
# "Couldn't run /usr/bin/dumpcap" 오류 시
sudo setcap cap_net_raw+eip $(which dumpcap)
sudo setcap cap_net_raw+eip $(which tshark)
# 또는 사용자를 wireshark 그룹에 추가
sudo usermod -aG wireshark $USER
# (로그아웃 후 재로그인 필요)
```

### strace 권한 오류

```bash
# "Operation not permitted" 오류 시
sudo sysctl -w kernel.yama.ptrace_scope=0
# 영구 설정:
echo "kernel.yama.ptrace_scope = 0" | sudo tee -a /etc/sysctl.d/10-ptrace.conf
```

### Frida 네이티브 빌드 실패

```bash
# build-essential 확인
sudo apt install -y build-essential python3-dev

# npm rebuild
cd mcp-servers/re-frida-mcp
npm rebuild frida
```

### gdb attach 실패

```bash
# "ptrace: Operation not permitted" 오류 시
# strace와 동일: ptrace_scope 설정 필요
sudo sysctl -w kernel.yama.ptrace_scope=0
```

---

## 11. 서비스 자동화 (선택)

### systemd 서비스 등록 (Ghidra MCP)

```bash
sudo cat > /etc/systemd/system/ghidra-mcp.service << 'EOF'
[Unit]
Description=Ghidra MCP Service
After=network.target

[Service]
Type=simple
User=YOUR_USER
Environment=DISPLAY=:0
Environment=GHIDRA_HOME=/opt/ghidra
Environment=GHIDRA_MCP_DIR=/opt/ghidra-mcp
ExecStart=/bin/bash /path/to/dokodemodoor/scripts/start-ghidra-mcp.sh start
ExecStop=/bin/bash /path/to/dokodemodoor/scripts/start-ghidra-mcp.sh stop
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable ghidra-mcp
sudo systemctl start ghidra-mcp
```

---

## 요약 체크리스트

| 단계 | 명령/확인 | 완료 |
|------|----------|------|
| 시스템 패키지 | `apt install nodejs npm git openjdk-21-jdk maven python3 strace gdb tshark` | ☐ |
| DiE 설치 | `diec --version` | ☐ |
| Ghidra 설치 | `ls /opt/ghidra/ghidraRun` | ☐ |
| ghidra-mcp 빌드 | `ls /opt/ghidra-mcp/target/*.zip` | ☐ |
| 플러그인 배포 | `ls ~/.ghidra/.ghidra_12.0.2_PUBLIC/Extensions/GhidraMCP` | ☐ |
| Python bridge | `python3 /opt/ghidra-mcp/bridge_mcp_ghidra.py --help` | ☐ |
| 프로젝트 npm | `npm run build` + 각 MCP 서버 `npm install` | ☐ |
| .env 설정 | LLM 설정 + RE 도구 경로 | ☐ |
| Ghidra MCP 시작 | `curl -sf http://127.0.0.1:8080/` → OK | ☐ |
| tshark 권한 | `tshark -i any -c 1` (비root) | ☐ |
| ptrace 권한 | `sysctl kernel.yama.ptrace_scope` → 0 | ☐ |
| Phase 1 테스트 | `--agent re-inventory` → deliverable 생성 | ☐ |
| Phase 2 테스트 | `--agent re-static` → deliverable + candidates 생성 | ☐ |
| Phase 3 테스트 | `--phase re-dynamic-observation` → 2개 deliverable 생성 | ☐ |
| Phase 4 테스트 | `--agent re-network` → deliverable 생성 | ☐ |
| 전체 E2E | 전체 파이프라인 실행 → 5개 Phase 완료 | ☐ |
