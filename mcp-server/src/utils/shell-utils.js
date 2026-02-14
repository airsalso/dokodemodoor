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
 * [목적] 잘못된 파일 경로 자동 복구 (README 대소문자, 프로젝트명 오타 포함).
 */
export async function recoverPath(p, targetDir) {
  // 빈 문자열/null/undefined → 프로젝트 루트로 기본 처리
  if (!p || !p.trim()) return targetDir;

  let cleanP = p.trim()
    .replace(/{{REPO_PATH}}\/?/g, '')
    .replace(/\$WORK_DIR\/?/g, targetDir + '/')
    .replace(/\$BINARY\b/g, global.__DOKODEMODOOR_BINARY_PATH || targetDir);
  if (!cleanP || cleanP === targetDir + '/') return targetDir;

  const targetAbs = path.resolve(targetDir);
  let absCandidate = path.isAbsolute(cleanP) ? cleanP : path.resolve(targetAbs, cleanP);

  // 1. Check exact existence
  if (fs.existsSync(absCandidate)) return absCandidate;

  // 1.5. Fuzzy project root recovery (LLM 프로젝트명 오타 보정)
  // LLM이 "dokodemodoor" 같은 긴 프로젝트명을 "dokodemodod" 등으로
  // 잘못 생성하는 환각(hallucination) 대응. 절대경로에서 targetDir의 상위 디렉토리까지
  // 일치하면 나머지 부분을 targetDir 기준으로 재조립.
  if (path.isAbsolute(cleanP)) {
    const recovered = fuzzyProjectRootRecover(cleanP, targetAbs);
    if (recovered) {
      console.log(chalk.gray(`      🔧 Fuzzy project-root recovered: ${cleanP} → ${recovered}`));
      absCandidate = recovered;
      if (fs.existsSync(absCandidate)) return absCandidate;
    }
  }

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
 * [목적] LLM이 프로젝트 루트 디렉토리명을 오타낸 절대경로를 targetDir 기준으로 보정.
 *
 * 예: targetDir = /home/ubuntu/dokodemodoor/repos/re-curl
 *     입력 경로 = /home/ubuntu/dokodemodod/repos/re-curl/some/file
 *     → 공통 상위(/home/ubuntu) + targetDir 이하 경로로 재조립
 *
 * 보안: targetDir의 부모 디렉토리가 일치하는 경우에만 보정하며,
 *       결과는 항상 targetDir 하위 경로로 제한됨.
 */
function fuzzyProjectRootRecover(inputPath, targetDir) {
  const inputParts = inputPath.split(path.sep).filter(Boolean);
  const targetParts = targetDir.split(path.sep).filter(Boolean);

  // 공통 prefix 길이 찾기
  let commonLen = 0;
  for (let i = 0; i < Math.min(inputParts.length, targetParts.length); i++) {
    if (inputParts[i] === targetParts[i]) {
      commonLen = i + 1;
    } else {
      break;
    }
  }

  // 공통 부분이 최소 1단계(예: /home)이고, targetDir 전체보다 짧아야 함
  // (완전히 일치하면 이미 정상 경로이므로 보정 불필요)
  if (commonLen < 1 || commonLen >= targetParts.length) return null;

  // 입력경로에서 diverge 이후의 상대 부분 추출
  // 예: /home/ubuntu/dokodemodod/repos/re-curl/file.txt
  //     diverge at index 2 ("dokodemodod" vs "dokodemodoor")
  //     inputParts 중 diverge 이후 = ["dokodemodod","repos","re-curl","file.txt"]
  //     targetParts 중 diverge 이후 = ["dokodemodoor","repos","re-curl"]
  const inputTail = inputParts.slice(commonLen);  // ["dokodemodod","repos","re-curl","file.txt"]
  const targetTail = targetParts.slice(commonLen); // ["dokodemodoor","repos","re-curl"]

  // targetTail 의 길이만큼 inputTail에서 건너뛰고, 나머지가 있으면 재조립
  // "repos/re-curl" 같은 하위 구조가 유사해야 보정 가치가 있음
  if (inputTail.length <= targetTail.length) {
    // 입력이 targetDir 자체 또는 그보다 짧은 경우 → targetDir 반환
    return targetDir;
  }

  // inputTail 에서 targetTail과 동일한 suffix를 찾아 매칭
  // 예: inputTail = [dokodemodod, repos, re-curl, file.txt]
  //     targetTail = [dokodemodoor, repos, re-curl]
  // targetTail[1:] = [repos, re-curl] 이 inputTail 어딘가에 있는지 확인
  const targetSubParts = targetTail.slice(1); // 오타 부분 제외한 나머지
  if (targetSubParts.length > 0) {
    // inputTail 에서 targetSubParts 시퀀스 찾기
    for (let i = 1; i <= inputTail.length - targetSubParts.length; i++) {
      const slice = inputTail.slice(i, i + targetSubParts.length);
      if (slice.every((part, idx) => part === targetSubParts[idx])) {
        // 매칭됨 — targetDir + inputTail의 나머지 부분으로 재조립
        const remainder = inputTail.slice(i + targetSubParts.length);
        const recovered = path.join(targetDir, ...remainder);
        return recovered;
      }
    }
  }

  // 하위 구조 매칭 실패 — 단순히 inputTail 끝부분(파일명)만 targetDir에 붙여보기
  const lastPart = inputTail[inputTail.length - 1];
  if (lastPart && lastPart !== inputTail[0]) {
    return path.join(targetDir, lastPart);
  }

  return null;
}

/**
 * [목적] 무거운 루트 스캔 차단.
 */
export function isHeavyRootCommand(command, workDir) {
  const isRoot = workDir === '/' || workDir === '/root' || workDir === '/home' || workDir === '/var';
  return isRoot && /^\s*(ls\s+-R|grep\s+-R|find\s+\/|rg\s+--files\s+\/|du\s+-h\s+\/)/i.test(command);
}
