/**
 * [목적] 페이즈별 파일 오픈/검색 상한을 앱 규모(repoFileCount, routeCount)에 따라 동적으로 산정.
 *
 * [호출자]
 * - checkpoint-manager.js (페이즈별 ensureScopeSizeAndCaps 호출 후 caps 전달)
 *
 * [출력]
 * - { fileOpenCap, searchCap } per phase; scope_size.json 캐시 under deliverables/_context/
 */

import { path, fs } from 'zx';
import { glob } from 'glob';

const IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', 'vendor', '__pycache__', '.next', 'coverage', '.venv'];
const MAX_DEPTH = 10;

/**
 * [목적] 대상 레포의 분석 대상 소스 파일 개수를 빠르게 카운트.
 * @param {string} targetRepo - 레포 루트 경로
 * @returns {Promise<number>}
 */
export async function getRepoFileCount(targetRepo) {
  if (!targetRepo) return 0;
  const repoRoot = path.resolve(targetRepo);
  if (!fs.existsSync(repoRoot)) return 0;

  try {
    const pattern = '**/*.{ts,js,mjs,cjs,jsx,tsx,py,java,go,rb,php,rs,c,cpp,h,hpp}';
    const files = await glob(pattern, {
      cwd: repoRoot,
      absolute: false,
      ignore: IGNORE_DIRS.map(d => `**/${d}/**`),
      nodir: true,
      maxDepth: MAX_DEPTH
    });
    return files.length;
  } catch (e) {
    return 0;
  }
}

/**
 * [목적] pre_recon_deliverable.md에서 라우트/엔드포인트 수를 단순 파싱.
 * @param {string} targetRepo - 레포 루트 (deliverables 경로 기준)
 * @returns {Promise<number>}
 */
export async function parsePreReconRouteCount(targetRepo) {
  if (!targetRepo) return 0;
  const mdPath = path.join(path.resolve(targetRepo), 'deliverables', 'pre_recon_deliverable.md');
  if (!fs.existsSync(mdPath)) return 0;
  try {
    const content = await fs.readFile(mdPath, 'utf8');
    // 표/리스트 형태의 라우트 줄 수 또는 "path", "route" 등 키워드 근처 숫자 추정
    const lines = content.split('\n').filter(l => /(\/[\w-]+|route|endpoint|path\s*:)/i.test(l));
    return Math.min(lines.length, 500);
  } catch {
    return 0;
  }
}

/**
 * [목적] 규모 지표 수집 (repoFileCount 필수, routeCount 선택).
 * @param {string} targetRepo
 * @param {{ parsePreRecon?: boolean }} opts
 * @returns {Promise<{ repoFileCount: number, routeCount?: number }>}
 */
export async function getScopeSize(targetRepo, opts = {}) {
  const repoFileCount = await getRepoFileCount(targetRepo);
  let routeCount = 0;
  if (opts.parsePreRecon) {
    routeCount = await parsePreReconRouteCount(targetRepo);
  }
  return { repoFileCount, routeCount: routeCount || undefined };
}

/**
 * [목적] 페이즈별 상한 공식 적용 (계획서 공식).
 * @param {string} phaseName - pre-reconnaissance | reconnaissance | vulnerability-analysis
 * @param {{ repoFileCount: number, routeCount?: number }} scopeSize
 * @returns {{ fileOpenCap: number, searchCap: number }}
 */
export function computePhaseCaps(phaseName, scopeSize) {
  const n = Math.max(0, scopeSize.repoFileCount || 0);
  const r = Math.max(0, scopeSize.routeCount || 0);

  switch (phaseName) {
    case 'pre-reconnaissance':
      return {
        fileOpenCap: Math.min(32, 8 + Math.floor(n / 50)),
        searchCap: Math.min(20, 4 + Math.floor(n / 100))
      };
    case 'reconnaissance':
      return {
        fileOpenCap: Math.min(24, 6 + Math.floor(n / 80) + Math.floor(r / 15)),
        searchCap: Math.min(16, 4 + Math.floor(n / 120))
      };
    case 'vulnerability-analysis':
      return {
        fileOpenCap: Math.min(16, 6 + Math.floor(n / 200)),
        searchCap: Math.min(12, 4 + Math.floor(n / 150))
      };
    default:
      return { fileOpenCap: 12, searchCap: 8 };
  }
}

/** 페이즈별 폴백(규모 수집 실패 시) */
const FALLBACK_CAPS = {
  'pre-reconnaissance': { fileOpenCap: 16, searchCap: 10 },
  'reconnaissance': { fileOpenCap: 14, searchCap: 8 },
  'vulnerability-analysis': { fileOpenCap: 12, searchCap: 8 }
};

/**
 * [목적] 페이즈 시작 시 scope_size 캐시 읽기/쓰기 후 해당 페이즈 caps 반환.
 * @param {object} session - { targetRepo, id }
 * @param {string} phaseName
 * @returns {Promise<{ fileOpenCap: number, searchCap: number }|null>}
 */
export async function ensureScopeSizeAndCaps(session, phaseName) {
  const capPhases = ['pre-reconnaissance', 'reconnaissance', 'vulnerability-analysis'];
  if (!capPhases.includes(phaseName)) {
    return null;
  }

  const targetRepo = session?.targetRepo;
  if (!targetRepo) return null;

  const contextDir = path.join(path.resolve(targetRepo), 'deliverables', '_context');
  const cachePath = path.join(contextDir, 'scope_size.json');

  let scopeSize = { repoFileCount: 0, routeCount: 0 };

  try {
    await fs.ensureDir(contextDir);
    if (fs.existsSync(cachePath)) {
      const raw = await fs.readFile(cachePath, 'utf8');
      const cached = JSON.parse(raw);
      scopeSize = { repoFileCount: cached.repoFileCount || 0, routeCount: cached.routeCount || 0 };
    }
  } catch {
    // ignore
  }

  if (scopeSize.repoFileCount === 0) {
    scopeSize = await getScopeSize(targetRepo, {
      parsePreRecon: phaseName === 'reconnaissance' || phaseName === 'vulnerability-analysis'
    });
    try {
      await fs.writeFile(cachePath, JSON.stringify(scopeSize, null, 2), 'utf8');
    } catch {
      // ignore
    }
  }

  if (scopeSize.repoFileCount === 0) {
    return FALLBACK_CAPS[phaseName] || { fileOpenCap: 12, searchCap: 8 };
  }

  return computePhaseCaps(phaseName, scopeSize);
}
