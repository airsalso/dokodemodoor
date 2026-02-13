#!/bin/bash
# =============================================================================
# DokodemoDoor — bethington/ghidra-mcp 옵션C 설치 스크립트
#
# [목적] Ghidra + ghidra-mcp 플러그인 + Xvfb 환경을 구성한다.
# [사용법] sudo bash scripts/setup-ghidra-mcp.sh
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

GHIDRA_VERSION="12.0.2"
GHIDRA_DATE="20250206"
GHIDRA_INSTALL_DIR="/opt/ghidra"
GHIDRA_MCP_DIR="/opt/ghidra-mcp"
GHIDRA_PROJECT_DIR="/tmp/ghidra-projects"

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  DokodemoDoor Ghidra MCP Setup${NC}"
echo -e "${CYAN}  Option C: Xvfb + GUI Plugin${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# -----------------------------------------------------------
# Step 1: 시스템 패키지 설치
# -----------------------------------------------------------
echo -e "${YELLOW}[1/6] 시스템 패키지 설치...${NC}"
apt-get update -qq
apt-get install -y -qq \
  maven \
  xvfb \
  x11vnc \
  wget \
  unzip \
  libxrender1 \
  libxtst6 \
  libxi6 \
  libfreetype6 \
  fontconfig \
  2>&1 | tail -3

echo -e "${GREEN}  ✅ 시스템 패키지 설치 완료${NC}"

# -----------------------------------------------------------
# Step 2: Ghidra 12.0.2 설치
# -----------------------------------------------------------
echo -e "${YELLOW}[2/6] Ghidra ${GHIDRA_VERSION} 설치...${NC}"

if [ -d "${GHIDRA_INSTALL_DIR}" ] && [ -f "${GHIDRA_INSTALL_DIR}/ghidraRun" ]; then
  echo -e "${GREEN}  ✅ Ghidra 이미 설치됨: ${GHIDRA_INSTALL_DIR}${NC}"
else
  cd /tmp
  GHIDRA_ZIP="ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_DATE}.zip"
  GHIDRA_URL="https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/${GHIDRA_ZIP}"

  if [ ! -f "${GHIDRA_ZIP}" ]; then
    echo "  다운로드: ${GHIDRA_URL}"
    wget -q --show-progress "${GHIDRA_URL}" -O "${GHIDRA_ZIP}" || {
      echo -e "${RED}  ❌ Ghidra 다운로드 실패. URL을 확인하세요.${NC}"
      exit 1
    }
  fi

  echo "  압축 해제 중..."
  unzip -qo "${GHIDRA_ZIP}" -d /opt/
  # 압축 해제된 디렉토리를 /opt/ghidra로 이동
  EXTRACTED_DIR=$(ls -d /opt/ghidra_${GHIDRA_VERSION}_PUBLIC* 2>/dev/null | head -1)
  if [ -n "${EXTRACTED_DIR}" ] && [ "${EXTRACTED_DIR}" != "${GHIDRA_INSTALL_DIR}" ]; then
    rm -rf "${GHIDRA_INSTALL_DIR}"
    mv "${EXTRACTED_DIR}" "${GHIDRA_INSTALL_DIR}"
  fi

  chmod +x "${GHIDRA_INSTALL_DIR}/ghidraRun"
  chmod +x "${GHIDRA_INSTALL_DIR}/support/analyzeHeadless"

  echo -e "${GREEN}  ✅ Ghidra ${GHIDRA_VERSION} 설치 완료: ${GHIDRA_INSTALL_DIR}${NC}"
fi

# -----------------------------------------------------------
# Step 3: bethington/ghidra-mcp 클론 및 빌드
# -----------------------------------------------------------
echo -e "${YELLOW}[3/6] bethington/ghidra-mcp 클론 및 빌드...${NC}"

if [ -d "${GHIDRA_MCP_DIR}" ]; then
  echo "  기존 디렉토리 업데이트: ${GHIDRA_MCP_DIR}"
  cd "${GHIDRA_MCP_DIR}"
  git pull --ff-only 2>/dev/null || true
else
  git clone https://github.com/bethington/ghidra-mcp.git "${GHIDRA_MCP_DIR}"
  cd "${GHIDRA_MCP_DIR}"
fi

# Ghidra 라이브러리 복사 (빌드에 필요)
echo "  Ghidra 라이브러리 복사 중..."
mkdir -p lib

# Required JARs from Ghidra Framework
for module in SoftwareModeling Project Docking Generic Utility Gui FileSystem Graph DB Emulation; do
  jar_path=$(find "${GHIDRA_INSTALL_DIR}/Ghidra/Framework/${module}/lib" -name "${module}.jar" 2>/dev/null | head -1)
  if [ -n "${jar_path}" ]; then
    cp "${jar_path}" lib/
  fi
done

# Required JARs from Ghidra Features
for module in Base Decompiler PDB FunctionID; do
  jar_path=$(find "${GHIDRA_INSTALL_DIR}/Ghidra/Features/${module}/lib" -name "${module}.jar" 2>/dev/null | head -1)
  if [ -n "${jar_path}" ]; then
    cp "${jar_path}" lib/
  fi
done

echo "  Maven 빌드 중 (테스트 스킵)..."
mvn clean package assembly:single -DskipTests -q 2>&1 | tail -5 || {
  echo -e "${YELLOW}  ⚠️ assembly:single 실패, package만 시도...${NC}"
  mvn clean package -DskipTests -q 2>&1 | tail -5
}

echo -e "${GREEN}  ✅ ghidra-mcp 빌드 완료${NC}"

# -----------------------------------------------------------
# Step 4: Ghidra에 플러그인 배포
# -----------------------------------------------------------
echo -e "${YELLOW}[4/6] Ghidra에 플러그인 배포...${NC}"

EXTENSIONS_DIR="${GHIDRA_INSTALL_DIR}/Extensions/Ghidra"
mkdir -p "${EXTENSIONS_DIR}"

# 빌드 산출물 찾기 (zip 또는 jar)
PLUGIN_ZIP=$(find target/ -name "GhidraMCP*.zip" 2>/dev/null | head -1)
if [ -n "${PLUGIN_ZIP}" ]; then
  cp "${PLUGIN_ZIP}" "${EXTENSIONS_DIR}/"
  echo "  플러그인 ZIP 복사: ${PLUGIN_ZIP}"
  # 확장 디렉토리에 압축 해제
  cd "${EXTENSIONS_DIR}"
  unzip -qo "$(basename "${PLUGIN_ZIP}")" 2>/dev/null || true
  cd "${GHIDRA_MCP_DIR}"
else
  echo -e "${YELLOW}  ZIP 없음, JAR 직접 복사...${NC}"
  PLUGIN_JAR=$(find target/ -name "GhidraMCP*.jar" -not -name "*sources*" -not -name "*javadoc*" 2>/dev/null | head -1)
  if [ -n "${PLUGIN_JAR}" ]; then
    cp "${PLUGIN_JAR}" "${EXTENSIONS_DIR}/"
    echo "  플러그인 JAR 복사: ${PLUGIN_JAR}"
  else
    echo -e "${RED}  ❌ 빌드 산출물을 찾을 수 없습니다${NC}"
    ls -la target/ 2>/dev/null
  fi
fi

echo -e "${GREEN}  ✅ 플러그인 배포 완료${NC}"

# -----------------------------------------------------------
# Step 5: Python bridge 의존성 설치
# -----------------------------------------------------------
echo -e "${YELLOW}[5/6] Python bridge 의존성 설치...${NC}"

cd "${GHIDRA_MCP_DIR}"
if [ -f "requirements.txt" ]; then
  pip3 install -r requirements.txt 2>&1 | tail -3
else
  pip3 install mcp httpx 2>&1 | tail -3
fi

echo -e "${GREEN}  ✅ Python 의존성 설치 완료${NC}"

# -----------------------------------------------------------
# Step 6: 디렉토리 및 권한 설정
# -----------------------------------------------------------
echo -e "${YELLOW}[6/6] 디렉토리 및 권한 설정...${NC}"

mkdir -p "${GHIDRA_PROJECT_DIR}"
chmod -R 755 "${GHIDRA_MCP_DIR}"

# 현재 사용자가 sudo로 실행한 경우, 실제 사용자에게 권한 부여
REAL_USER="${SUDO_USER:-$(whoami)}"
chown -R "${REAL_USER}:${REAL_USER}" "${GHIDRA_MCP_DIR}" 2>/dev/null || true
chown -R "${REAL_USER}:${REAL_USER}" "${GHIDRA_PROJECT_DIR}" 2>/dev/null || true

echo -e "${GREEN}  ✅ 설정 완료${NC}"

# -----------------------------------------------------------
# 요약
# -----------------------------------------------------------
echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  설치 완료 요약${NC}"
echo -e "${CYAN}========================================${NC}"
echo -e "  Ghidra:     ${GHIDRA_INSTALL_DIR}"
echo -e "  GhidraMCP:  ${GHIDRA_MCP_DIR}"
echo -e "  Bridge:     ${GHIDRA_MCP_DIR}/bridge_mcp_ghidra.py"
echo -e "  Projects:   ${GHIDRA_PROJECT_DIR}"
echo ""
echo -e "${YELLOW}다음 단계:${NC}"
echo -e "  1. Ghidra MCP 서비스 시작:"
echo -e "     bash scripts/start-ghidra-mcp.sh"
echo -e "  2. 서비스 상태 확인:"
echo -e "     bash scripts/start-ghidra-mcp.sh status"
echo -e "  3. 서비스 중지:"
echo -e "     bash scripts/start-ghidra-mcp.sh stop"
echo ""
