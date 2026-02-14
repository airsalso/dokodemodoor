/**
 * Shell & File System Utilities (Hardened & Smart)
 */

import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { execSync } from 'node:child_process';

/**
 * [목적] 쉘 이스케이프 지원용 쿼팅.
 */
export function shQuote(str) {
  if (!str) return '""';
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * [목적] ripgrep(rg) 설치 여부를 안전하게 캐싱 및 확인.
 */
export function isRgAvailable() {
  if (typeof global.__DOKODEMODOOR_RG_AVAILABLE === 'undefined') {
    try {
      execSync('command -v rg', { stdio: 'ignore' });
      global.__DOKODEMODOOR_RG_AVAILABLE = true;
    } catch (e) {
      global.__DOKODEMODOOR_RG_AVAILABLE = false;
    }
  }
  return global.__DOKODEMODOOR_RG_AVAILABLE;
}

/**
 * [목적] 경로가 타겟 디렉토리(Sandbox) 내부에 있는지 검증 및 강제.
 *
 * 보안 주의:
 * - prefix 비교만으로는 /repo vs /repo2 같은 형제 디렉터리 접근을 허용할 수 있음
 * - 따라서 정확한 일치 또는 path.sep 포함 prefix를 검사
 * - symlink를 통한 탈출을 방지하기 위해 realpath 기반으로 정규화
 */
export function ensureInSandbox(p, targetDir) {
  // realpath: symlink를 해소하여 실제 경로로 정규화 (탈출 방지)
  let targetAbs;
  try {
    targetAbs = fs.realpathSync(path.resolve(targetDir));
  } catch {
    targetAbs = path.resolve(targetDir);
  }

  let requestedAbs;
  try {
    // 존재하는 경로는 realpath로 symlink 해소
    requestedAbs = fs.realpathSync(path.resolve(p));
  } catch {
    // 아직 존재하지 않는 경로(새 파일 생성 등) — resolve로 정규화 후 검사
    requestedAbs = path.resolve(p);
  }

  // 정확한 일치(디렉토리 자체) 또는 하위 경로(path.sep 포함) 검사
  const isInSandbox = requestedAbs === targetAbs ||
                      requestedAbs.startsWith(targetAbs + path.sep);

  if (!isInSandbox) {
    console.error(chalk.red(`[SECURITY] Blocked out-of-sandbox access: ${p}`));
    throw new Error(`Permission Denied: Access outside project root is not allowed.`);
  }
  return requestedAbs;
}

/**
 * [목적] LLM의 커맨드 관련 환각(Hallucination) 제거 및 JSON 래핑 해제.
 */
export function scrubCommand(command) {
  if (typeof command !== 'string') return command;

  let cleaned = command.trim();

  // Handle JSON-wrapped command
  if (cleaned.startsWith('{') && cleaned.includes('command')) {
    try {
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed.command === 'string') {
        cleaned = parsed.command;
      }
    } catch (e) {
      const match = cleaned.match(/"command"\s*:\s*"((?:\\.|[^"])*)"/);
      if (match) {
        cleaned = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
  }

  // Handle common prefixes
  const hadJsonishPrefix = /^\s*\{/.test(cleaned) || /^(command|bash|sh|sh -c)\s*:/i.test(cleaned);
  cleaned = cleaned.replace(/^\{\s*(command|bash|sh|sh -c)\s*:/i, '');
  cleaned = cleaned.replace(/^(command|bash|sh|sh -c)\s*:/i, '');
  cleaned = cleaned.replace(/\}\s*$/, '');

  if (hadJsonishPrefix || /,\s*(timeout|cwd|env|args|path)\s*::/i.test(cleaned) || /,\s*"?\s*(timeout|cwd|env|args|path)\s*"?\s*:/i.test(cleaned)) {
    cleaned = cleaned.replace(/\]\s*,\s*"?\s*(timeout|cwd|env|args|path)\s*"?\s*:\s*.*$/i, '');
    cleaned = cleaned.replace(/,\s*"?\s*(timeout|cwd|env|args|path)\s*"?\s*:\s*.*$/i, '');
    cleaned = cleaned.replace(/\]\s*$/, '');
  }

  return cleaned.trim();
}

/**
 * [목적] 명령어와 경로가 따로 전해졌을 때 자동 보정.
 */
export function autoFixCommand(command, filePath) {
  if (!filePath || !command || command.includes('|')) return command;

  const commonTools = ['cat', 'sed', 'head', 'tail', 'grep', 'wc', 'strings', 'ls', 'find'];
  const firstWord = command.trim().split(/\s+/)[0].toLowerCase();

  if (commonTools.includes(firstWord)) {
    const escapedPath = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pathRegex = new RegExp(`(^|\\s)["']?${escapedPath}["']?(\\s|$)`);

    if (!pathRegex.test(command)) {
      return `${command.trim()} ${shQuote(filePath)}`;
    }
  }
  return command;
}

/**
 * [목적] 잘못된 파일 경로 자동 복구 (README 대소문자 포함).
 */
export async function recoverPath(p, targetDir) {
  if (!p) return p;

  let cleanP = p.trim().replace(/{{REPO_PATH}}\/?/g, '');
  if (!cleanP) return targetDir;

  const targetAbs = path.resolve(targetDir);
  let absCandidate = path.isAbsolute(cleanP) ? cleanP : path.resolve(targetAbs, cleanP);

  // 1. Check exact existence
  if (fs.existsSync(absCandidate)) return absCandidate;

  // 2. README Case-Insensitive Recovery
  try {
    const base = path.basename(absCandidate);
    const dir = path.dirname(absCandidate);
    if (base.toLowerCase() === 'readme.md' && fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir);
      const match = entries.find(name => name.toLowerCase() === 'readme.md');
      if (match) {
        const recovered = path.join(dir, match);
        console.log(chalk.gray(`      🔧 README case-recovered: ${recovered}`));
        return recovered;
      }
    }
  } catch (e) { /* ignore */ }

  // 3. Basename Search (ripgrep)
  try {
    const base = path.basename(cleanP);
    if (base && isRgAvailable()) {
      const match = execSync(`rg --files -g '**/${base}' ${shQuote(targetAbs)} | head -n 1`, { encoding: 'utf8' }).trim();
      if (match && fs.existsSync(match)) {
         console.log(chalk.gray(`      🔧 Path recovered via rg: ${match}`));
         return match;
      }
    }
  } catch (e) { /* ignore */ }

  // 4. Absolute Path Missing Slash Recovery
  if (!cleanP.startsWith('/')) {
    const correctedPath = '/' + cleanP;
    if (correctedPath.includes(targetAbs) && fs.existsSync(correctedPath)) {
      console.log(chalk.gray(`      🔧 Slash-recovered: ${correctedPath}`));
      return correctedPath;
    }
  }

  return absCandidate;
}

/**
 * [목적] 무거운 루트 스캔 차단.
 */
export function isHeavyRootCommand(command, workDir) {
  const isRoot = workDir === '/' || workDir === '/root' || workDir === '/home' || workDir === '/var';
  return isRoot && /^\s*(ls\s+-R|grep\s+-R|find\s+\/|rg\s+--files\s+\/|du\s+-h\s+\/)/i.test(command);
}
