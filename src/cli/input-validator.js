import { fs, path } from 'zx';

// Helper function: Validate web URL
/**
 * [목적] 웹 대상 URL 유효성 검사.
 *
 * [호출자]
 * - dokodemodoor.mjs CLI 입력 검증
 *
 * [출력 대상]
 * - { valid, error? } 반환
 *
 * [입력 파라미터]
 * - url (string)
 *
 * [반환값]
 * - object
 */
export function validateWebUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Web URL must use HTTP or HTTPS protocol' };
    }
    if (!parsed.hostname) {
      return { valid: false, error: 'Web URL must have a valid hostname' };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, error: 'Invalid web URL format' };
  }
}

// Helper function: Validate local repository path
/**
 * [목적] 로컬 레포 경로 유효성 검사 및 절대경로 반환.
 *
 * [호출자]
 * - dokodemodoor.mjs CLI 입력 검증
 *
 * [출력 대상]
 * - { valid, error? , path? } 반환
 *
 * [입력 파라미터]
 * - repoPath (string)
 *
 * [반환값]
 * - Promise<object>
 */
export async function validateRepoPath(repoPath) {
  try {
    // Check if path exists
    if (!await fs.pathExists(repoPath)) {
      return { valid: false, error: 'Repository path does not exist' };
    }

    // Check if it's a directory
    const stats = await fs.stat(repoPath);
    if (!stats.isDirectory()) {
      return { valid: false, error: 'Repository path must be a directory' };
    }

    // Check if it's readable
    try {
      await fs.access(repoPath, fs.constants.R_OK);
    } catch (error) {
      return { valid: false, error: 'Repository path is not readable' };
    }

    // Convert to absolute path
    const absolutePath = path.resolve(repoPath);
    return { valid: true, path: absolutePath };
  } catch (error) {
    return { valid: false, error: `Invalid repository path: ${error.message}` };
  }
}
