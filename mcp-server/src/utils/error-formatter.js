/**
 * Error Formatting Utilities
 *
 * Helper functions for creating structured error responses.
 */

/**
 * @typedef {Object} ErrorResponse
 * @property {'error'} status
 * @property {string} message
 * @property {string} errorType
 * @property {boolean} retryable
 * @property {Record<string, unknown>} [context]
 */

/**
 * [목적] 검증 오류 응답 생성.
 *
 * [호출자]
 * - save_deliverable, validator 등
 *
 * [출력 대상]
 * - ErrorResponse 반환
 */
export function createValidationError(message, retryable = true, context) {
  return {
    status: 'error',
    message,
    errorType: 'ValidationError',
    retryable,
    context,
  };
}

/**
 * [목적] 암호 관련 오류 응답 생성.
 *
 * [호출자]
 * - generate_totp 등
 *
 * [출력 대상]
 * - ErrorResponse 반환
 */
export function createCryptoError(message, retryable = false, context) {
  return {
    status: 'error',
    message,
    errorType: 'CryptoError',
    retryable,
    context,
  };
}

/**
 * [목적] 일반 오류 응답 생성.
 *
 * [호출자]
 * - MCP 도구 전반
 *
 * [출력 대상]
 * - ErrorResponse 반환
 */
export function createGenericError(error, retryable = false, context) {
  const message = error instanceof Error ? error.message : String(error);
  const errorType = error instanceof Error ? error.constructor.name : 'UnknownError';

  return {
    status: 'error',
    message,
    errorType,
    retryable,
    context,
  };
}
