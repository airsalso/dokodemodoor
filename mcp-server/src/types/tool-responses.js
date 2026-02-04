/**
 * Tool Response Type Definitions
 *
 * Defines structured response formats for MCP tools to ensure
 * consistent error handling and success reporting.
 */

/**
 * @typedef {Object} ErrorResponse
 * @property {'error'} status
 * @property {string} message
 * @property {string} errorType - ValidationError, FileSystemError, CryptoError, etc.
 * @property {boolean} retryable
 * @property {Record<string, unknown>} [context]
 */

/**
 * @typedef {Object} SuccessResponse
 * @property {'success'} status
 * @property {string} message
 */

/**
 * @typedef {Object} SaveDeliverableResponse
 * @property {'success'} status
 * @property {string} message
 * @property {string} filepath
 * @property {string} deliverableType
 * @property {boolean} validated - true if queue JSON was validated
 */

/**
 * @typedef {Object} GenerateTotpResponse
 * @property {'success'} status
 * @property {string} message
 * @property {string} totpCode
 * @property {string} timestamp
 * @property {number} expiresIn - seconds until expiration
 */

/**
 * [목적] MCP 도구 응답을 표준 ToolResult 포맷으로 변환.
 *
 * [호출자]
 * - mcp-server 도구 구현들 (save_deliverable, generate_totp 등)
 *
 * [출력 대상]
 * - ToolResult 객체 반환
 *
 * [입력 파라미터]
 * - response (ErrorResponse | SaveDeliverableResponse | GenerateTotpResponse)
 *
 * [반환값]
 * - { content: Array<{ type: string; text: string }>, isError: boolean }
 */
export function createToolResult(response) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(response, null, 2),
      },
    ],
    isError: response.status === 'error',
  };
}
