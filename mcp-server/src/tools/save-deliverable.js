/**
 * save_deliverable MCP Tool
 *
 * Saves deliverable files with automatic validation.
 * Replaces tools/save_deliverable.js bash script.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { DeliverableType, DELIVERABLE_FILENAMES, isQueueType, isEvidenceType } from '../types/deliverables.js';
import { createToolResult } from '../types/tool-responses.js';
import { validateQueueJson } from '../validation/queue-validator.js';
import { validateEvidenceJson } from '../validation/evidence-validator.js';
import { saveDeliverableFile } from '../utils/file-operations.js';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { getTargetDir } from '../../../src/utils/context.js';
import { createValidationError, createGenericError } from '../utils/error-formatter.js';

/**
 * Input schema for save_deliverable tool
 */
export const SaveDeliverableInputSchema = z.object({
  deliverable_type: z.nativeEnum(DeliverableType).describe('Type of deliverable to save'),
  content: z.string().min(1).describe('File content (markdown for analysis/evidence, JSON for queues)'),
});

/**
 * save_deliverable tool implementation
 *
 * @param {Object} args
 * @param {string} args.deliverable_type - Type of deliverable to save
 * @param {string} args.content - File content
 * @returns {Promise<Object>} Tool result
 */
/**
* [목적] 유효성 검사를 거쳐 전달 가능한 파일을 저장하고 표준화된 도구 응답을 반환합니다.
*
* [호출 경로]
* - mcp-server/src/tools/tool-registry.js::registerMCPTools()는 이 핸들러를 등록합니다.
* - 컨텍스트: AI 에이전트의 MCP 도구 호출(save_deliverable)을 통해 호출됩니다.
*
* [출력 대상]
* - 도구 레지스트리/에이전트 실행기에서 사용하는 ToolResult 객체를 반환합니다.
* - saveDeliverableFile()을 통해 대상 저장소 deliverables/에 파일을 저장합니다.
*
* [입력 매개변수]
* - args.deliverable_type (문자열): 전달 가능한 파일 유형 열거형.
* - args.content (문자열): Markdown 또는 JSON 콘텐츠.
*
* [반환 값]
* - Promise<Object>: 상태/메시지/경로가 포함된 표준화된 도구 결과.
*
* [부작용]
* - 파일 시스템이 전달물 디렉터리에 기록됩니다.
*
* [의존성]
* - validateQueueJson(), saveDeliverableFile(), DeliverableType 매핑.
*
* [흐름]
* - 전달물 유형이 큐인 경우 큐 JSON을 검증합니다.
* - 전달물 유형에서 파일 이름을 확인하고 파일을 기록합니다.
* - 성공 또는 형식화된 오류 결과를 반환합니다.
*
* [오류 처리]
* - 유효성 검사 오류는 구조화된 도구 오류(비예외)를 반환합니다.
* - 예상치 못한 오류는 포착하여 일반 오류로 래핑합니다.
*
* [참고]
* - saveDeliverableFile() 함수는 내용이 짧은 대용량 파일을 덮어쓰는 것을 방지합니다.
**/
export async function saveDeliverable(args) {
  try {
    const { deliverable_type, content } = args;

    let finalContent = content;
    const deliverablesDir = join(getTargetDir(), 'deliverables');
    const queueMergeLogPath = join(deliverablesDir, 'queue-merge.log');
    const logQueueMerge = (message) => {
      const timestamp = new Date().toISOString();
      const line = `[${timestamp}] ${message}\n`;
      console.log(message);
      try {
        appendFileSync(queueMergeLogPath, line, 'utf8');
      } catch (logError) {
        console.log(`[QUEUE MERGE] Failed to write queue-merge.log: ${logError.message}`);
      }
    };

    // Validate queue JSON if applicable
    if (isQueueType(deliverable_type)) {
      // Merge with existing queue if present (append-only, no de-duplication)
      const filename = DELIVERABLE_FILENAMES[deliverable_type];
      const existingPath = join(deliverablesDir, filename);

      if (existsSync(existingPath)) {
        try {
          const existingRaw = readFileSync(existingPath, 'utf8');
          // Use robust validation/parsing for both existing and incoming content
          const existingValidation = validateQueueJson(existingRaw);
          const incomingValidation = validateQueueJson(content);

          if (!incomingValidation.valid && !existingValidation.valid) {
            throw new Error(`Both existing and incoming JSON are invalid: ${incomingValidation.message}`);
          }

          const existingJson = existingValidation.data || {};
          const incomingJson = incomingValidation.data || {};

          const existingList = Array.isArray(existingJson?.vulnerabilities) ? existingJson.vulnerabilities : [];
          const incomingList = Array.isArray(incomingJson?.vulnerabilities) ? incomingJson.vulnerabilities : [];

          // [SMART DEDUPLICATION]
          // Use a combination of vulnerability_type and source as a unique key
          const seenKeys = new Set();
          const mergedList = [];

          const addToList = (item) => {
            if (!item || typeof item !== 'object') return;
            // Create a normalization key: lowercase and strip whitespace
            const sourceKey = String(item.source || '').toLowerCase().replace(/\s+/g, '');
            const typeKey = String(item.vulnerability_type || '').toLowerCase();
            const uniqueKey = `${typeKey}|${sourceKey}`;

            if (!seenKeys.has(uniqueKey)) {
              seenKeys.add(uniqueKey);
              mergedList.push(item);
              return true;
            }
            return false;
          };

          // Prioritize existing findings (don't overwrite unless necessary)
          existingList.forEach(addToList);
          let addedCount = 0;
          incomingList.forEach(item => {
            if (addToList(item)) addedCount++;
          });

          finalContent = JSON.stringify(
            { vulnerabilities: mergedList },
            null,
            2
          );
          logQueueMerge(`[QUEUE MERGE] ${filename}: existing ${existingList.length} + new ${addedCount} (deduplicated) = ${mergedList.length}`);
        } catch (mergeError) {
          // If merge fails, fall back to incoming content
          finalContent = content;
          logQueueMerge(`[QUEUE MERGE] ${filename}: merge failed (${mergeError.message}); falling back to incoming content`);
        }
      } else {
        try {
          const incomingValidation = validateQueueJson(content);
          const incomingJson = incomingValidation.data || {};
          const incomingList = Array.isArray(incomingJson?.vulnerabilities) ? incomingJson.vulnerabilities : [];
          logQueueMerge(`[QUEUE MERGE] ${filename}: no existing queue; incoming ${incomingList.length}`);
          if (incomingValidation.valid) {
            finalContent = JSON.stringify(incomingJson, null, 2);
          }
        } catch (parseError) {
          logQueueMerge(`[QUEUE MERGE] ${filename}: no existing queue; incoming (unparsed)`);
        }
      }

      const queueValidation = validateQueueJson(finalContent);
      if (!queueValidation.valid) {
        const errorResponse = createValidationError(
          queueValidation.message,
          true,
          {
            deliverableType: deliverable_type,
            expectedFormat: '{"vulnerabilities": [...]}',
          }
        );
        return createToolResult(errorResponse);
      }
    }

    // Validate evidence JSON if applicable
    if (isEvidenceType(deliverable_type)) {
      // Best-effort body truncation before parsing to avoid JSON escape failures
      const stripBodyFields = (raw) => {
        const bodyRegex = /"body"\s*:\s*"((?:\\.|[^"\\])*)"/g;
        return raw.replace(bodyRegex, '"body":"[omitted]"');
      };

      const autoCloseJson = (raw) => {
        let inString = false;
        let escaped = false;
        const stack = [];
        for (let i = 0; i < raw.length; i++) {
          const ch = raw[i];
          if (inString) {
            if (escaped) {
              escaped = false;
            } else if (ch === '\\') {
              escaped = true;
            } else if (ch === '"') {
              inString = false;
            }
            continue;
          }

          if (ch === '"') {
            inString = true;
            continue;
          }
          if (ch === '{' || ch === '[') {
            stack.push(ch);
            continue;
          }
          if (ch === '}' || ch === ']') {
            const expected = ch === '}' ? '{' : '[';
            if (stack.length && stack[stack.length - 1] === expected) {
              stack.pop();
            }
          }
        }

        if (inString) {
          return raw; // cannot safely auto-close if string literal is unterminated
        }

        let out = raw.trimEnd();
        while (stack.length) {
          const open = stack.pop();
          out += open === '{' ? '}' : ']';
        }
        return out;
      };

      finalContent = autoCloseJson(stripBodyFields(finalContent));

      const normalizeEvidenceJson = (raw) => {
        const validation = validateEvidenceJson(raw);
        if (!validation.valid) return raw;
        const parsed = validation.data;
        if (!parsed?.vulnerabilities || !Array.isArray(parsed.vulnerabilities)) return raw;

        for (const vuln of parsed.vulnerabilities) {
          if (!Array.isArray(vuln.evidence)) continue;
          for (const item of vuln.evidence) {
            if (item?.type === 'http_request_response') {
              if (item.request && typeof item.request.body === 'string' && item.request.body.length > 2000) {
                item.request.body = item.request.body.slice(0, 2000) + '... [truncated]';
              }
              if (item.response && typeof item.response.body === 'string' && item.response.body.length > 2000) {
                item.response.body = item.response.body.slice(0, 2000) + '... [truncated]';
              }
              if (item.response && item.response.headers) {
                const headerStr = JSON.stringify(item.response.headers);
                if (headerStr.length > 8000) {
                  item.response.headers = { note: 'headers truncated; too large' };
                }
              }
            }
            if (typeof item?.description === 'string' && item.description.length > 2000) {
              item.description = item.description.slice(0, 2000) + '... [truncated]';
            }
          }
        }

        return JSON.stringify(parsed);
      };

      try {
        finalContent = normalizeEvidenceJson(finalContent);
      } catch (e) {
        // If normalization fails, keep current content so regular validator can report specific errors
      }

      const evidenceValidation = validateEvidenceJson(finalContent);
      if (!evidenceValidation.valid) {
        const errorResponse = createValidationError(
          evidenceValidation.message,
          true,
          {
            deliverableType: deliverable_type,
            expectedFormat: '{"vulnerability_id": "...", "evidence": [...], "reproduction_steps": [...]}',
          }
        );
        return createToolResult(errorResponse);
      }

      // Enforce screenshot evidence file existence to prevent hallucinated artifacts
      const parsedEvidence = evidenceValidation.data;
      const screenshotBaseDir = join(deliverablesDir, 'screenshots');
      for (let j = 0; j < parsedEvidence.vulnerabilities.length; j++) {
        const vuln = parsedEvidence.vulnerabilities[j];
        for (let i = 0; i < vuln.evidence.length; i++) {
          const item = vuln.evidence[i];
          if (item.type !== 'screenshot') continue;

          const rawPath = item.path;
          const candidates = [];
          if (rawPath && typeof rawPath === 'string') {
            if (rawPath.startsWith('/')) {
              candidates.push(rawPath);
            } else {
              candidates.push(join(deliverablesDir, rawPath));
              candidates.push(join(screenshotBaseDir, rawPath));
            }
          }

          const exists = candidates.some((p) => existsSync(p));
          if (!exists) {
            const errorResponse = createValidationError(
              `Screenshot file not found at vulnerabilities[${j}].evidence[${i}]: '${rawPath}'. Checked: ${candidates.join(', ') || 'no paths'}`,
              true,
              {
                deliverableType: deliverable_type,
                expectedFormat: '{"vulnerability_id": "...", "evidence": [...], "reproduction_steps": [...]}',
              }
            );
            return createToolResult(errorResponse);
          }
        }
      }
    }

    // Get filename and save file
    const filename = DELIVERABLE_FILENAMES[deliverable_type];
    const { filepath, filename: finalFilename } = saveDeliverableFile(filename, finalContent);

    // Success response
    const successResponse = {
      status: 'success',
      message: `Deliverable saved successfully: ${finalFilename}`,
      filepath,
      deliverableType: deliverable_type,
      validated: isQueueType(deliverable_type) || isEvidenceType(deliverable_type),
    };

    return createToolResult(successResponse);
  } catch (error) {
    const errorResponse = createGenericError(
      error,
      false,
      { deliverableType: args.deliverable_type }
    );

    return createToolResult(errorResponse);
  }
}

/**
 * Tool definition for MCP server - created using SDK's tool() function
 */
export const saveDeliverableTool = tool(
  'save_deliverable',
  'Saves deliverable files with automatic validation. Queue files must have {"vulnerabilities": [...]} structure.',
  SaveDeliverableInputSchema.shape,
  saveDeliverable
);
