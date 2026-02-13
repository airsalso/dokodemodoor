#!/bin/bash
# =============================================================================
# DokodemoDoor — Ghidra MCP 서비스 관리 스크립트
#
# [목적] Xvfb + Ghidra GUI + MCP bridge를 백그라운드 서비스로 관리한다.
# [사용법]
#   bash scripts/start-ghidra-mcp.sh          # 시작
#   bash scripts/start-ghidra-mcp.sh stop      # 중지
#   bash scripts/start-ghidra-mcp.sh status    # 상태 확인
#   bash scripts/start-ghidra-mcp.sh restart   # 재시작
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

GHIDRA_HOME="${GHIDRA_HOME:-/opt/ghidra}"
GHIDRA_MCP_DIR="${GHIDRA_MCP_DIR:-/opt/ghidra-mcp}"
DISPLAY_NUM="${GHIDRA_DISPLAY:-99}"
GHIDRA_MCP_HTTP_PORT="${GHIDRA_MCP_HTTP_PORT:-8080}"
MCP_BRIDGE_PORT="${MCP_BRIDGE_PORT:-8081}"
PIDFILE_DIR="/tmp/dokodemodoor-ghidra"
LOG_DIR="/tmp/dokodemodoor-ghidra/logs"

mkdir -p "${PIDFILE_DIR}" "${LOG_DIR}"

XVFB_PID_FILE="${PIDFILE_DIR}/xvfb.pid"
GHIDRA_PID_FILE="${PIDFILE_DIR}/ghidra.pid"
BRIDGE_PID_FILE="${PIDFILE_DIR}/bridge.pid"

# -----------------------------------------------------------
# 유틸 함수
# -----------------------------------------------------------
is_running() {
  local pidfile="$1"
  if [ -f "${pidfile}" ]; then
    local pid
    pid=$(cat "${pidfile}")
    if kill -0 "${pid}" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

wait_for_port() {
  local port="$1"
  local timeout="${2:-60}"
  local elapsed=0
  while [ ${elapsed} -lt ${timeout} ]; do
    if curl -sf "http://127.0.0.1:${port}/check_connection" >/dev/null 2>&1 || \
       curl -sf "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
    echo -n "."
  done
  return 1
}

# -----------------------------------------------------------
# START
# -----------------------------------------------------------
do_start() {
  echo -e "${CYAN}🔬 DokodemoDoor Ghidra MCP 서비스 시작${NC}"
  echo ""

  # 1. Xvfb 시작
  if is_running "${XVFB_PID_FILE}"; then
    echo -e "${GREEN}  ✅ Xvfb 이미 실행 중 (PID: $(cat "${XVFB_PID_FILE}"))${NC}"
  else
    echo -e "${YELLOW}  [1/3] Xvfb 시작 (DISPLAY=:${DISPLAY_NUM})...${NC}"
    Xvfb ":${DISPLAY_NUM}" -screen 0 1920x1080x24 -ac +extension GLX +render -noreset \
      > "${LOG_DIR}/xvfb.log" 2>&1 &
    echo $! > "${XVFB_PID_FILE}"
    sleep 2

    if is_running "${XVFB_PID_FILE}"; then
      echo -e "${GREEN}  ✅ Xvfb 시작됨 (PID: $(cat "${XVFB_PID_FILE}"))${NC}"
    else
      echo -e "${RED}  ❌ Xvfb 시작 실패. 로그: ${LOG_DIR}/xvfb.log${NC}"
      return 1
    fi
  fi

  export DISPLAY=":${DISPLAY_NUM}"

  # 2. Ghidra 시작 (MCP 플러그인 자동 로드)
  if is_running "${GHIDRA_PID_FILE}"; then
    echo -e "${GREEN}  ✅ Ghidra 이미 실행 중 (PID: $(cat "${GHIDRA_PID_FILE}"))${NC}"
  else
    echo -e "${YELLOW}  [2/3] Ghidra 시작 중...${NC}"
    DISPLAY=":${DISPLAY_NUM}" "${GHIDRA_HOME}/ghidraRun" \
      > "${LOG_DIR}/ghidra.log" 2>&1 &
    echo $! > "${GHIDRA_PID_FILE}"

    # Ghidra가 MCP HTTP 서버를 열 때까지 대기
    echo -n "    Ghidra MCP 서버 대기 중 (최대 120초)"
    if wait_for_port "${GHIDRA_MCP_HTTP_PORT}" 120; then
      echo ""
      echo -e "${GREEN}  ✅ Ghidra MCP 서버 준비됨 (http://127.0.0.1:${GHIDRA_MCP_HTTP_PORT})${NC}"
    else
      echo ""
      echo -e "${RED}  ❌ Ghidra MCP 서버 타임아웃${NC}"
      echo -e "${YELLOW}  ⚠️  Ghidra가 시작된 후 수동으로 Tools > GhidraMCP > Start MCP Server를 실행하세요${NC}"
      echo -e "${YELLOW}  ⚠️  또는 Ghidra 설정에서 GhidraMCP 자동 시작을 활성화하세요${NC}"
      echo -e "${YELLOW}  💡 VNC로 확인: x11vnc -display :${DISPLAY_NUM} -nopw -forever &${NC}"
    fi
  fi

  # 3. MCP Bridge 시작
  if is_running "${BRIDGE_PID_FILE}"; then
    echo -e "${GREEN}  ✅ MCP Bridge 이미 실행 중 (PID: $(cat "${BRIDGE_PID_FILE}"))${NC}"
  else
    echo -e "${YELLOW}  [3/3] MCP Bridge 시작 중...${NC}"

    # bridge_mcp_ghidra.py 는 stdio 또는 SSE 모드로 실행
    # DokodemoDoor에서는 stdio 래퍼를 통해 호출하므로, SSE 데몬 모드로 대기
    python3 "${GHIDRA_MCP_DIR}/bridge_mcp_ghidra.py" \
      --transport sse \
      --mcp-host 127.0.0.1 \
      --mcp-port "${MCP_BRIDGE_PORT}" \
      --ghidra-server "http://127.0.0.1:${GHIDRA_MCP_HTTP_PORT}/" \
      > "${LOG_DIR}/bridge.log" 2>&1 &
    echo $! > "${BRIDGE_PID_FILE}"
    sleep 3

    if is_running "${BRIDGE_PID_FILE}"; then
      echo -e "${GREEN}  ✅ MCP Bridge 시작됨 (PID: $(cat "${BRIDGE_PID_FILE}"), SSE port: ${MCP_BRIDGE_PORT})${NC}"
    else
      echo -e "${RED}  ❌ MCP Bridge 시작 실패. 로그: ${LOG_DIR}/bridge.log${NC}"
    fi
  fi

  echo ""
  echo -e "${CYAN}서비스 상태:${NC}"
  do_status
}

# -----------------------------------------------------------
# STOP
# -----------------------------------------------------------
do_stop() {
  echo -e "${CYAN}🛑 DokodemoDoor Ghidra MCP 서비스 중지${NC}"

  for name_pid in "Bridge:${BRIDGE_PID_FILE}" "Ghidra:${GHIDRA_PID_FILE}" "Xvfb:${XVFB_PID_FILE}"; do
    local name="${name_pid%%:*}"
    local pidfile="${name_pid#*:}"

    if is_running "${pidfile}"; then
      local pid
      pid=$(cat "${pidfile}")
      echo -e "  ${name} 중지 (PID: ${pid})..."
      kill "${pid}" 2>/dev/null || true
      sleep 2
      # 강제 종료
      kill -9 "${pid}" 2>/dev/null || true
      rm -f "${pidfile}"
      echo -e "${GREEN}  ✅ ${name} 중지됨${NC}"
    else
      echo -e "  ${name}: 실행 중 아님"
      rm -f "${pidfile}"
    fi
  done
}

# -----------------------------------------------------------
# STATUS
# -----------------------------------------------------------
do_status() {
  local all_ok=true

  for name_pid in "Xvfb:${XVFB_PID_FILE}" "Ghidra:${GHIDRA_PID_FILE}" "Bridge:${BRIDGE_PID_FILE}"; do
    local name="${name_pid%%:*}"
    local pidfile="${name_pid#*:}"

    if is_running "${pidfile}"; then
      echo -e "  ${GREEN}●${NC} ${name} — 실행 중 (PID: $(cat "${pidfile}"))"
    else
      echo -e "  ${RED}○${NC} ${name} — 중지됨"
      all_ok=false
    fi
  done

  # HTTP 헬스체크
  if curl -sf "http://127.0.0.1:${GHIDRA_MCP_HTTP_PORT}/check_connection" >/dev/null 2>&1; then
    echo -e "  ${GREEN}●${NC} Ghidra HTTP — 응답 OK (port ${GHIDRA_MCP_HTTP_PORT})"
  else
    echo -e "  ${RED}○${NC} Ghidra HTTP — 응답 없음 (port ${GHIDRA_MCP_HTTP_PORT})"
    all_ok=false
  fi

  echo ""
  echo -e "  로그 디렉토리: ${LOG_DIR}/"

  if ${all_ok}; then
    return 0
  else
    return 1
  fi
}

# -----------------------------------------------------------
# MAIN
# -----------------------------------------------------------
case "${1:-start}" in
  start)   do_start ;;
  stop)    do_stop ;;
  status)  do_status ;;
  restart) do_stop; sleep 2; do_start ;;
  *)
    echo "Usage: $0 {start|stop|status|restart}"
    exit 1
    ;;
esac
