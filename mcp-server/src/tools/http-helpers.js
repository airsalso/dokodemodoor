/**
 * HTTP Request Helper Tool
 *
 * Provides utilities for crafting well-formed HTTP requests,
 * including automatic Content-Length calculation.
 */

import { z } from 'zod';

/**
 * Input schema for build_http_request tool
 */
export const BuildHttpRequestInputSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).describe('HTTP method'),
  path: z.string().describe('Request path (e.g., /api/login)'),
  host: z.string().describe('Target host (e.g., target.com)'),
  headers: z.record(z.string()).optional().describe('Additional headers as key-value pairs'),
  body: z.string().optional().describe('Request body (for POST/PUT/PATCH)'),
  use_https: z.boolean().optional().default(true).describe('Use HTTPS (default: true)')
});

/**
 * [목적] 완전한 형식의 HTTP 요청을 자동으로 생성하고 Content-Length를 계산합니다.
 *
 * [호출자]
 * - AI 에이전트가 네트워크 요청을 직접 생성하기 전에 호출 (예: curl 명령 구성용)
 *
 * [출력 대상]
 * - 완전한 HTTP 요청 문자열 반환 (CRLF 포함) - curl --data-binary 등과 함께 사용 가능
 *
 * [입력 파라미터]
 * - method: HTTP 메서드
 * - path: 요청 경로
 * - host: 대상 호스트
 * - headers: 추가 헤더 (선택)
 * - body: 요청 본문 (선택)
 * - use_https: HTTPS 사용 여부
 *
 * [반환값]
 * - {request: string, info: object}
 */
export async function buildHttpRequest(args) {
  const { method, path, host, headers = {}, body = '', use_https = true } = args;

  // Calculate Content-Length for body
  const bodyBytes = Buffer.byteLength(body, 'utf8');

  // Build headers map
  const allHeaders = {
    'Host': host,
    ...headers
  };

  // Add Content-Length and Content-Type for methods with body
  if (['POST', 'PUT', 'PATCH'].includes(method) && body) {
    if (!allHeaders['Content-Type']) {
      // Auto-detect content type
      try {
        JSON.parse(body);
        allHeaders['Content-Type'] = 'application/json';
      } catch {
        allHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }
    allHeaders['Content-Length'] = bodyBytes.toString();
  }

  // Build request line
  const requestLine = `${method} ${path} HTTP/1.1`;

  // Build header lines
  const headerLines = Object.entries(allHeaders)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');

  // Assemble complete request
  const request = body
    ? `${requestLine}\r\n${headerLines}\r\n\r\n${body}`
    : `${requestLine}\r\n${headerLines}\r\n\r\n`;

  return {
    status: 'success',
    request: request,
    info: {
      method,
      path,
      host,
      protocol: use_https ? 'HTTPS' : 'HTTP',
      content_length: bodyBytes,
      total_size: Buffer.byteLength(request, 'utf8'),
      headers: allHeaders
    }
  };
}

/**
 * Input schema for calculate_content_length tool
 */
export const CalculateContentLengthInputSchema = z.object({
  body: z.string().describe('HTTP request body to measure')
});

/**
 * [목적] HTTP 요청 본문의 정확한 바이트 길이를 계산합니다.
 *
 * [호출자]
 * - AI 에이전트가 수동으로 Content-Length를 계산할 때
 *
 * [입력 파라미터]
 * - body: 측정할 본문 문자열
 *
 * [반환값]
 * - {length: number, info: object}
 */
export async function calculateContentLength(args) {
  const { body } = args;
  const byteLength = Buffer.byteLength(body, 'utf8');
  const charLength = body.length;

  return {
    status: 'success',
    length: byteLength,
    info: {
      byte_length: byteLength,
      character_length: charLength,
      has_multibyte: byteLength !== charLength,
      sample: body.substring(0, 100) + (body.length > 100 ? '...' : '')
    }
  };
}

/**
 * Input schema for parse_http_request tool
 */
export const ParseHttpRequestInputSchema = z.object({
  request: z.string().describe('Raw HTTP request to parse')
});

/**
 * [목적] 원시 HTTP 요청을 파싱하여 구성 요소를 추출합니다.
 *
 * [호출자]
 * - AI 에이전트가 캡처된 트래픽이나 응답을 분석할 때
 *
 * [입력 파라미터]
 * - request: 원시 HTTP 요청 문자열
 *
 * [반환값]
 * - {method, path, headers, body, info}
 */
export async function parseHttpRequest(args) {
  const { request } = args;

  try {
    // Split request into lines
    const lines = request.split(/\r?\n/);

    // Parse request line
    const requestLine = lines[0];
    const [method, path, protocol] = requestLine.split(' ');

    // Find blank line separating headers from body
    const blankLineIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === '');

    // Parse headers
    const headerLines = lines.slice(1, blankLineIndex > 0 ? blankLineIndex : lines.length);
    const headers = {};
    for (const line of headerLines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        headers[key] = value;
      }
    }

    // Extract body
    const body = blankLineIndex > 0
      ? lines.slice(blankLineIndex + 1).join('\n')
      : '';

    const bodyLength = Buffer.byteLength(body, 'utf8');
    const declaredLength = headers['Content-Length'] ? parseInt(headers['Content-Length']) : null;

    return {
      status: 'success',
      method,
      path,
      protocol,
      headers,
      body,
      info: {
        header_count: Object.keys(headers).length,
        body_length: bodyLength,
        declared_content_length: declaredLength,
        content_length_match: declaredLength === bodyLength,
        has_body: body.length > 0
      }
    };
  } catch (error) {
    return {
      status: 'error',
      message: `Failed to parse HTTP request: ${error.message}`,
      sample: request.substring(0, 200)
    };
  }
}

export const BashToolSchema = z.object({
  command: z.string().describe('Bash command to execute')
});
