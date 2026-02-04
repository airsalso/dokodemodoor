/**
 * generate_totp MCP Tool
 *
 * Generates 6-digit TOTP codes for authentication.
 * Replaces tools/generate-totp-standalone.mjs bash script.
 * Based on RFC 6238 (TOTP) and RFC 4226 (HOTP).
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { createHmac } from 'crypto';
import { z } from 'zod';
import { createToolResult } from '../types/tool-responses.js';
import { base32Decode, validateTotpSecret } from '../validation/totp-validator.js';
import { createCryptoError, createGenericError } from '../utils/error-formatter.js';
import { getLocalISOString } from '../utils/time-utils.js';

/**
 * Input schema for generate_totp tool
 */
export const GenerateTotpInputSchema = z.object({
  secret: z
    .string()
    .min(1)
    .regex(/^[A-Z2-7]+$/i, 'Must be base32-encoded')
    .describe('Base32-encoded TOTP secret'),
});

/**
 * Generate HOTP code (RFC 4226)
 * Ported from generate-totp-standalone.mjs (lines 74-99)
 *
 * @param {string} secret - Base32-encoded secret
 * @param {number} counter - Counter value
 * @param {number} [digits=6] - Number of digits in OTP
 * @returns {string} OTP code
 */
/**
 * [목적] HOTP 코드 생성 (RFC 4226).
 *
 * [호출자]
 * - generateTOTP()
 *
 * [출력 대상]
 * - 6자리 OTP 문자열 반환
 *
 * [입력 파라미터]
 * - secret (string)
 * - counter (number)
 * - digits (number)
 *
 * [반환값]
 * - string
 */
function generateHOTP(secret, counter, digits = 6) {
  const key = base32Decode(secret);

  // Convert counter to 8-byte buffer (big-endian)
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  // Generate HMAC-SHA1
  const hmac = createHmac('sha1', key);
  hmac.update(counterBuffer);
  const hash = hmac.digest();

  // Dynamic truncation
  const offset = hash[hash.length - 1] & 0x0f;
  const code =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  // Generate digits
  const otp = (code % Math.pow(10, digits)).toString().padStart(digits, '0');
  return otp;
}

/**
 * Generate TOTP code (RFC 6238)
 * Ported from generate-totp-standalone.mjs (lines 101-106)
 *
 * @param {string} secret - Base32-encoded secret
 * @param {number} [timeStep=30] - Time step in seconds
 * @param {number} [digits=6] - Number of digits in OTP
 * @returns {string} OTP code
 */
/**
 * [목적] TOTP 코드 생성 (RFC 6238).
 *
 * [호출자]
 * - generateTotp()
 *
 * [출력 대상]
 * - 6자리 OTP 문자열 반환
 *
 * [입력 파라미터]
 * - secret (string)
 * - timeStep (number)
 * - digits (number)
 *
 * [반환값]
 * - string
 */
function generateTOTP(secret, timeStep = 30, digits = 6) {
  const currentTime = Math.floor(Date.now() / 1000);
  const counter = Math.floor(currentTime / timeStep);
  return generateHOTP(secret, counter, digits);
}

/**
 * Get seconds until TOTP code expires
 *
 * @param {number} [timeStep=30] - Time step in seconds
 * @returns {number} Seconds until expiration
 */
/**
 * [목적] 현재 TOTP 코드의 만료까지 남은 초 계산.
 *
 * [호출자]
 * - generateTotp()
 *
 * [반환값]
 * - number
 */
function getSecondsUntilExpiration(timeStep = 30) {
  const currentTime = Math.floor(Date.now() / 1000);
  return timeStep - (currentTime % timeStep);
}

/**
 * generate_totp tool implementation
 *
 * @param {Object} args
 * @param {string} args.secret - Base32-encoded TOTP secret
 * @returns {Promise<Object>} Tool result
 */
/**
 * [목적] TOTP 생성 도구 본체 실행.
 *
 * [호출자]
 * - MCP tool 호출 (generate_totp)
 *
 * [출력 대상]
 * - ToolResult 반환
 *
 * [입력 파라미터]
 * - args.secret (string)
 *
 * [반환값]
 * - Promise<object>
 */
export async function generateTotp(args) {
  try {
    const { secret } = args;

    // Validate secret (throws on error)
    validateTotpSecret(secret);

    // Generate TOTP code
    const totpCode = generateTOTP(secret);
    const expiresIn = getSecondsUntilExpiration();
    const timestamp = getLocalISOString();

    // Success response
    const successResponse = {
      status: 'success',
      message: 'TOTP code generated successfully',
      totpCode,
      timestamp,
      expiresIn,
    };

    return createToolResult(successResponse);
  } catch (error) {
    // Check if it's a validation/crypto error
    if (error instanceof Error && (error.message.includes('base32') || error.message.includes('TOTP'))) {
      const errorResponse = createCryptoError(error.message, false);
      return createToolResult(errorResponse);
    }

    // Generic error
    const errorResponse = createGenericError(error, false);
    return createToolResult(errorResponse);
  }
}

/**
 * Tool definition for MCP server - created using SDK's tool() function
 */
export const generateTotpTool = tool(
  'generate_totp',
  'Generates 6-digit TOTP code for authentication. Secret must be base32-encoded.',
  GenerateTotpInputSchema.shape,
  generateTotp
);
