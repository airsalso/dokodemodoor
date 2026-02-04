/**
 * File Operations Utilities
 *
 * Handles file system operations for deliverable saving.
 * Ported from tools/save_deliverable.js (lines 117-130).
 */

import { writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { getTargetDir } from '../../../src/utils/context.js';

const FINAL_REPORT_FILENAME = 'comprehensive_security_assessment_report.md';
const RECON_REPORT_FILENAME = 'recon_deliverable.md';

function containsKorean(text) {
  return /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(text);
}

/**
 * [목적] deliverables/ 하위에 파일을 저장하며 길이 감소 보호를 수행.
 *
 * [호출자]
 * - save_deliverable 도구
 *
 * [출력 대상]
 * - 저장된 파일 경로 반환
 *
 * [입력 파라미터]
 * - filename (string)
 * - content (string)
 *
 * [반환값]
 * - { filepath: string, filename: string, redirected?: boolean }
 *
 * [에러 처리]
 * - 기존 파일 대비 70% 미만 축소 시 Error 발생
 */
export function saveDeliverableFile(filename, content) {
  // Use target directory from context
  const targetDir = getTargetDir();
  const deliverablesDir = join(targetDir, 'deliverables');
  let filepath = join(deliverablesDir, filename);

  // Ensure deliverables directory exists
  try {
    mkdirSync(deliverablesDir, { recursive: true });
  } catch (error) {}

  // PROTECTION: Check if file already exists and compare length
  if (existsSync(filepath)) {
    const stats = statSync(filepath);
    const existingSize = stats.size;
    const newSize = Buffer.byteLength(content, 'utf8');

    let threshold = 0.7; // Default: block if more than 30% reduction
    // REASONING: recon-verify agent (which produces recon_deliverable.md) is expected to shrink content
    // significantly by removing speculative/hallucinated vectors during the hardening phase.
    if (filename === RECON_REPORT_FILENAME) {
      threshold = 0.9; // STRICT: recon-verify must preserve almost all original work while hardening.
    }

    // If new content is less than threshold (and existing size is meaningful > 2k), treat as regression
    if (newSize < existingSize * threshold && existingSize > 2000) {
      if (filename === FINAL_REPORT_FILENAME && containsKorean(content)) {
        const existingContent = readFileSync(filepath, 'utf8');
        const normalizedExisting = existingContent.trimStart();
        const normalizedNew = content.trimEnd();

        // Avoid duplicate prepend if the same summary already exists at the top.
        if (!normalizedExisting.startsWith(normalizedNew)) {
          const merged = `${normalizedNew}\n\n---\n\n${existingContent}`;
          writeFileSync(filepath, merged, 'utf8');
        }
        return { filepath, filename, redirected: false };
      }

      console.error(`[GUARD] Refusing to overwrite ${filename} with significantly shorter content (${newSize} vs ${existingSize} bytes).`);
      throw new Error(`Data loss prevention: The new content for '${filename}' is significantly shorter than the existing version. Current: ${existingSize} bytes, New: ${newSize} bytes. Overwrite blocked to prevent data loss. Please ensure you are adding value and not truncating detailed findings.`);
    }
  }

  // Write file (atomic write - single operation)
  writeFileSync(filepath, content, 'utf8');

  return { filepath, filename, redirected: false };
}
