#!/usr/bin/env node

/**
 * Prompt lint
 *
 * Purpose:
 * - Prevent prompt regressions that break runtime contracts (tools/verdicts/completion).
 * - Keep checks cheap and deterministic (no network, no LLM).
 */

import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const promptsDir = path.join(repoRoot, 'prompts-openai');

const RULES_ALL = [
  {
    id: 'no-write_to_file',
    test: (line) => /\bwrite_to_file\b/.test(line),
    message: 'Nonexistent tool name: use `write_file` (not `write_to_file`).',
  },
  {
    id: 'no-TodoRead',
    test: (line) => /\bTodoRead\b/.test(line),
    message: 'Nonexistent tool name: remove `TodoRead` (use `TodoWrite` only).',
  },
];

const RULES_EXPLOIT = [
  {
    id: 'no-two-final-files',
    test: (line) => /\btwo final files\b/i.test(line),
    message: 'Exploit prompts must not instruct "two final files" (exploit specialists save one *_EVIDENCE file).',
  },
  {
    id: 'no-false-positive-classification',
    test: (line) => /\bfalse\s+positive\b/i.test(line),
    message: 'Exploit prompts must not use "false positive" as a classification; map outcomes to `EXPLOITED | BLOCKED_BY_SECURITY | POTENTIAL`.',
  },
  {
    id: 'no-not-vulnerable-classification',
    // Avoid flagging generic phrasing like "Assume NOT vulnerable..." (not a verdict label).
    test: (line) => /\bNOT VULNERABLE\b/.test(line),
    message: 'Exploit prompts must not use "NOT VULNERABLE" as a verdict; map outcomes to `EXPLOITED | BLOCKED_BY_SECURITY | POTENTIAL`.',
  },
];

const isExploitPrompt = (filePath) => path.basename(filePath).startsWith('exploit-');

const scanFile = async (filePath) => {
  const rel = path.relative(repoRoot, filePath);
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split('\n');

  const violations = [];
  const rules = [
    ...RULES_ALL,
    ...(isExploitPrompt(filePath) ? RULES_EXPLOIT : []),
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of rules) {
      if (rule.test(line)) {
        violations.push({
          file: rel,
          line: i + 1,
          rule: rule.id,
          message: rule.message,
          excerpt: line.trim().slice(0, 200),
        });
      }
    }
  }

  return violations;
};

const main = async () => {
  let files = [];
  try {
    files = await glob('**/*.txt', { cwd: promptsDir, absolute: true, nodir: true });
  } catch (error) {
    console.error(`prompt-lint: failed to glob prompts: ${error.message}`);
    process.exit(2);
  }

  const allViolations = [];
  for (const filePath of files) {
    try {
      const violations = await scanFile(filePath);
      allViolations.push(...violations);
    } catch (error) {
      console.error(`prompt-lint: failed to read ${filePath}: ${error.message}`);
      process.exit(2);
    }
  }

  if (allViolations.length === 0) {
    console.log('prompt-lint: OK');
    process.exit(0);
  }

  console.error(`prompt-lint: FAIL (${allViolations.length} violation(s))`);
  for (const v of allViolations) {
    const loc = `${v.file}:${v.line}`;
    const excerpt = v.excerpt ? ` | ${v.excerpt}` : '';
    console.error(`- ${loc} [${v.rule}] ${v.message}${excerpt}`);
  }

  process.exit(1);
};

await main();
