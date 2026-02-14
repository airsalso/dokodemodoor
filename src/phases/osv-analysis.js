import { fs, path, $ } from 'zx';
import { glob } from 'glob';
import chalk from 'chalk';
import { PentestError } from '../error-handling.js';
import { getAgentName, getTargetDir } from '../utils/context.js';
import { getLogTimestamp } from '../utils/time-utils.js';
import { DOKODEMODOOR_ROOT } from '../audit/utils.js';

// ─────────────────────────────────────────────
// OSV Ecosystem Map (internal type → OSV API ecosystem name)
// ─────────────────────────────────────────────
const OSV_ECOSYSTEM_MAP = {
  npm: 'npm',
  pip: 'PyPI',
  maven: 'Maven',
  gradle: 'Maven',   // Gradle dependencies are Maven artifacts
  go: 'Go',
  ruby: 'RubyGems',
  php: 'Packagist',
  rust: 'crates.io',
  nuget: 'NuGet',
  dart: 'Pub',
};

// ─────────────────────────────────────────────
// Manifest file → ecosystem type mapping
// ─────────────────────────────────────────────
const MANIFEST_CHECKS = [
  // Lockfiles first (more accurate resolved versions)
  { type: 'npm',    file: 'package-lock.json',  lockFor: 'package.json' },
  { type: 'npm',    file: 'yarn.lock',          lockFor: 'package.json' },
  { type: 'npm',    file: 'pnpm-lock.yaml',     lockFor: 'package.json' },
  { type: 'ruby',   file: 'Gemfile.lock',       lockFor: 'Gemfile' },
  { type: 'php',    file: 'composer.lock',       lockFor: 'composer.json' },
  { type: 'pip',    file: 'Pipfile.lock',        lockFor: 'Pipfile' },
  { type: 'pip',    file: 'poetry.lock',         lockFor: 'pyproject.toml' },
  { type: 'rust',   file: 'Cargo.lock',          lockFor: 'Cargo.toml' },
  // Standard manifests
  { type: 'npm',    file: 'package.json' },
  { type: 'pip',    file: 'requirements.txt' },
  { type: 'pip',    file: 'pyproject.toml' },
  { type: 'pip',    file: 'Pipfile' },
  { type: 'maven',  file: 'pom.xml' },
  { type: 'gradle', file: 'build.gradle' },
  { type: 'gradle', file: 'build.gradle.kts' },
  { type: 'go',     file: 'go.mod' },
  { type: 'ruby',   file: 'Gemfile' },
  { type: 'php',    file: 'composer.json' },
  { type: 'rust',   file: 'Cargo.toml' },
  { type: 'nuget',  file: 'packages.config' },
  { type: 'gradle', file: 'libs.versions.toml' },
  { type: 'dart',   file: 'pubspec.yaml' },
  { type: 'dart',   file: 'pubspec.lock' },
];

// Glob ignore patterns
const GLOB_IGNORE = [
  '**/node_modules/**', '**/vendor/**', '**/target/**',
  '**/build/**', '**/dist/**', '**/.git/**', '**/venv/**',
  '**/__pycache__/**', '**/bin/**', '**/obj/**',
];

/**
 * [목적] 오픈소스 취약점 분석(SCA) 단계 수행.
 *
 * [호출자]
 * - checkpoint-manager, osv-scanner.mjs
 *
 * [입력 파라미터]
 * - session (object)
 * - runAgentPromptWithRetry (function)
 * - loadPrompt (function)
 *
 * [반환값]
 * - Promise<object>
 */
export async function executeOsvAnalysisPhase(session, runAgentPromptWithRetry, loadPrompt) {
  const sourceDir = session.targetRepo || session.repoPath;
  console.log(chalk.cyan.bold('\n🔍 PHASE: OPEN SOURCE VULNERABILITY ANALYSIS'));

  // 1. Ecosystem Detection
  const ecosystems = await detectEcosystems(sourceDir);
  if (ecosystems.length === 0) {
    console.log(chalk.yellow('⚠️  No supported ecosystems (npm, pip, maven, gradle, go, ruby, php, rust, nuget, dart) detected.'));
    return { success: true, message: 'No ecosystems detected' };
  }

  const types = [...new Set(ecosystems.map(e => e.type))];
  console.log(chalk.blue(`📂 Detected ecosystems: ${types.join(', ')} (${ecosystems.length} manifest(s))`));

  // 2. Dependency Extraction & OSV Query
  const allVulnerabilities = [];
  for (const ecosystem of ecosystems) {
    console.log(chalk.gray(`   Processing ${ecosystem.type} (${ecosystem.file}) ...`));
    const deps = await extractDependencies(ecosystem);
    if (deps.length === 0) {
      console.log(chalk.gray(`     → 0 dependencies extracted, skipping OSV query`));
      continue;
    }
    console.log(chalk.gray(`     → ${deps.length} dependencies extracted`));
    const vulns = await queryOsvBatch(deps, ecosystem.type, sourceDir);
    allVulnerabilities.push(...vulns);
  }

  if (allVulnerabilities.length === 0) {
    console.log(chalk.green('✅ No known vulnerabilities found in open source dependencies.'));
  } else {
    const totalVulnCount = allVulnerabilities.reduce((acc, curr) => acc + (curr.vulnerabilities?.length || 0), 0);
    console.log(chalk.red(`🚨 Found ${totalVulnCount} individual vulnerabilities across ${allVulnerabilities.length} packages.`));
  }

  // 3. AI Analysis
  const variables = {
    webUrl: session.webUrl,
    repoPath: session.repoPath,
    sourceDir: sourceDir,
    vulnerabilityData: JSON.stringify(allVulnerabilities, null, 2)
  };

  const prompt = await loadPrompt('osv-analysis', variables, session.config);
  const result = await runAgentPromptWithRetry(
    prompt,
    sourceDir,
    'Read,Web',
    '',
    'OSV Analysis Agent',
    'osv-analysis',
    chalk.magenta,
    { id: session.id, webUrl: session.webUrl, repoPath: session.repoPath, configFile: session.configFile }
  );

  // 4. Automatic Consistency Check
  if (result.success) {
    try {
      const reportFile = path.join(sourceDir, 'deliverables', 'osv_analysis_deliverable.md');
      const queueFile = path.join(sourceDir, 'deliverables', 'osv_exploitation_queue.json');

      if (await fs.pathExists(reportFile) && await fs.pathExists(queueFile)) {
        const reportContent = await fs.readFile(reportFile, 'utf8');
        const queueData = await fs.readJson(queueFile);

        const reportMatchCount = (reportContent.match(/^### .*/gm) || []).length;
        const queueCount = queueData.vulnerabilities?.length || 0;

        if (reportMatchCount < queueCount) {
          console.log(chalk.yellow(`\n⚠️  Consistency Warning: Report has ${reportMatchCount} sections, but Queue has ${queueCount} vulnerabilities.`));
          console.log(chalk.gray(`   It seems the agent might have merged some findings or skipped the report sections.`));
        } else {
          console.log(chalk.green(`\n✅ Consistency Verified: Both deliverables contain ${queueCount} vulnerability entries.`));
        }
      }
    } catch (err) {
      // Non-critical check, ignore errors
    }
  }

  return result;
}

// ═════════════════════════════════════════════
// ECOSYSTEM DETECTION
// ═════════════════════════════════════════════

/**
 * [목적] 프로젝트 루트 및 하위 디렉터리에서 매니페스트/락파일 감지.
 * 모노레포, 하위 디렉터리 프로젝트 모두 지원. 락파일이 존재하면 해당 매니페스트를 대체.
 *
 * [exported] scripts/osv-scanner.mjs에서도 사용
 */
export async function detectEcosystems(sourceDir) {
  const ecosystems = [];
  const seenKey = new Set(); // type:absolutePath dedup

  // Helper: add ecosystem if not already seen
  const addEco = (type, file, absPath) => {
    const key = `${type}:${absPath}`;
    if (seenKey.has(key)) return;
    seenKey.add(key);
    ecosystems.push({ type, file, path: absPath });
  };

  // Track which manifest files are superseded by lockfiles
  const lockfileSupersedes = new Map(); // dir → Set<manifestFile>

  // 1) Root check — both lockfiles and manifests
  for (const check of MANIFEST_CHECKS) {
    const filePath = path.join(sourceDir, check.file);
    if (await fs.pathExists(filePath)) {
      if (check.lockFor) {
        const dir = sourceDir;
        if (!lockfileSupersedes.has(dir)) lockfileSupersedes.set(dir, new Set());
        lockfileSupersedes.get(dir).add(check.lockFor);
      }
      addEco(check.type, check.file, filePath);
    }
  }

  // Root check for .NET project files (*.csproj, *.fsproj, *.vbproj)
  const rootCsprojFiles = await glob('*.{csproj,fsproj,vbproj}', { cwd: sourceDir, nodir: true });
  for (const file of rootCsprojFiles) {
    addEco('nuget', file, path.join(sourceDir, file));
  }

  // Gradle version catalog (commonly at gradle/libs.versions.toml)
  const gradleCatalog = path.join(sourceDir, 'gradle', 'libs.versions.toml');
  if (await fs.pathExists(gradleCatalog)) {
    addEco('gradle', 'libs.versions.toml', gradleCatalog);
  }

  // Remove manifests superseded by lockfiles (same dir)
  for (const [dir, superseded] of lockfileSupersedes) {
    for (const manifest of superseded) {
      const manifestPath = path.join(dir, manifest);
      const key = `${getTypeForFile(manifest)}:${manifestPath}`;
      if (seenKey.has(key)) {
        seenKey.delete(key);
        const idx = ecosystems.findIndex(e => e.path === manifestPath);
        if (idx >= 0) ecosystems.splice(idx, 1);
      }
    }
  }

  // 2) Subdirectory search (always, to support monorepos)
  const allPatterns = MANIFEST_CHECKS.map(c => `**/${c.file}`);
  // Add wildcard patterns for files with variable names (.csproj, .fsproj, .vbproj)
  allPatterns.push('**/*.csproj', '**/*.fsproj', '**/*.vbproj');
  const uniquePatterns = [...new Set(allPatterns)];
  const subLockSupersedes = new Map();

  for (const pattern of uniquePatterns) {
    const files = await glob(pattern, {
      cwd: sourceDir,
      nodir: true,
      ignore: GLOB_IGNORE,
      maxDepth: 6,
    });
    for (const rel of files) {
      // Skip root files (already handled)
      if (!rel.includes('/') && !rel.includes('\\')) continue;
      const absPath = path.join(sourceDir, rel);
      const basename = path.basename(rel);
      const dir = path.dirname(absPath);

      // Determine type: known manifest or .NET project files
      let type = getTypeForFile(basename);
      if (!type && /\.(csproj|fsproj|vbproj)$/.test(basename)) {
        type = 'nuget';
      }
      if (!type) continue;

      const checkDef = MANIFEST_CHECKS.find(c => c.file === basename);
      if (checkDef?.lockFor) {
        if (!subLockSupersedes.has(dir)) subLockSupersedes.set(dir, new Set());
        subLockSupersedes.get(dir).add(checkDef.lockFor);
      }
      addEco(type, basename, absPath);
    }
  }

  // Remove sub-dir manifests superseded by their lockfiles
  for (const [dir, superseded] of subLockSupersedes) {
    for (const manifest of superseded) {
      const manifestPath = path.join(dir, manifest);
      const key = `${getTypeForFile(manifest)}:${manifestPath}`;
      if (seenKey.has(key)) {
        seenKey.delete(key);
        const idx = ecosystems.findIndex(e => e.path === manifestPath);
        if (idx >= 0) ecosystems.splice(idx, 1);
      }
    }
  }

  // Limit per-type to avoid huge monorepos flooding
  const perType = {};
  const limited = [];
  for (const eco of ecosystems) {
    perType[eco.type] = (perType[eco.type] || 0) + 1;
    if (perType[eco.type] <= 5) limited.push(eco);
  }

  return limited;
}

function getTypeForFile(filename) {
  const entry = MANIFEST_CHECKS.find(c => c.file === filename);
  return entry ? entry.type : null;
}

// ═════════════════════════════════════════════
// DEPENDENCY EXTRACTION
// ═════════════════════════════════════════════

/**
 * [목적] 매니페스트/락파일에서 의존성(name, version) 목록 추출.
 * 지원: npm, pip, maven, gradle, go, ruby, php, rust, nuget, dart
 *
 * [exported] scripts/osv-scanner.mjs에서도 사용
 */
export async function extractDependencies(ecosystem) {
  const deps = [];
  try {
    const content = await fs.readFile(ecosystem.path, 'utf8');
    const file = ecosystem.file;

    switch (ecosystem.type) {
      case 'npm':
        extractNpm(content, file, deps);
        break;
      case 'pip':
        extractPython(content, file, deps);
        break;
      case 'maven':
        extractMaven(content, deps);
        break;
      case 'gradle':
        extractGradle(content, file, deps);
        break;
      case 'go':
        extractGo(content, deps);
        break;
      case 'ruby':
        extractRuby(content, file, deps);
        break;
      case 'php':
        extractPhp(content, file, deps);
        break;
      case 'rust':
        extractRust(content, file, deps);
        break;
      case 'nuget':
        extractNuget(content, file, deps);
        break;
      case 'dart':
        extractDart(content, file, deps);
        break;
    }
  } catch (error) {
    console.log(chalk.yellow(`   ⚠️ Failed to extract dependencies from ${ecosystem.path}: ${error.message}`));
  }
  return deps;
}

// ── npm ──────────────────────────────────────

function extractNpm(content, file, deps) {
  if (file === 'package-lock.json') {
    return extractNpmLockfile(content, deps);
  }
  if (file === 'yarn.lock') {
    return extractYarnLock(content, deps);
  }
  if (file === 'pnpm-lock.yaml') {
    return extractPnpmLock(content, deps);
  }
  // package.json
  const pkg = JSON.parse(content);
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const [name, version] of Object.entries(allDeps)) {
    const clean = cleanSemver(typeof version === 'string' ? version : '');
    if (clean) deps.push({ name, version: clean });
  }
}

function extractNpmLockfile(content, deps) {
  const lock = JSON.parse(content);
  // lockfileVersion 2/3 uses "packages", v1 uses "dependencies"
  const packages = lock.packages || {};
  for (const [key, info] of Object.entries(packages)) {
    if (!key || key === '') continue; // root package
    const name = key.replace(/^node_modules\//, '');
    if (name.includes('node_modules/')) continue; // skip nested
    if (info.version) deps.push({ name, version: info.version });
  }
  if (deps.length === 0 && lock.dependencies) {
    for (const [name, info] of Object.entries(lock.dependencies)) {
      if (info.version) deps.push({ name, version: info.version });
    }
  }
}

function extractYarnLock(content, deps) {
  // yarn.lock format: "package@version:" followed by "  version "x.y.z""
  const re = /^"?([^@\s][^@]*?)@[^:]+:[\s\S]*?\n\s+version\s+"([^"]+)"/gm;
  let m;
  const seen = new Set();
  while ((m = re.exec(content)) !== null) {
    const name = m[1].replace(/"/g, '');
    const version = m[2];
    if (!seen.has(name)) {
      seen.add(name);
      deps.push({ name, version });
    }
  }
}

function extractPnpmLock(content, deps) {
  // pnpm-lock.yaml: lines like "  /package-name/version:" or "  package-name@version:"
  const re = /^\s+\/?([^@\s][^@\s]*?)[@/](\d+\.\d+[^:]*?):/gm;
  let m;
  const seen = new Set();
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const version = m[2];
    if (!seen.has(name)) {
      seen.add(name);
      deps.push({ name, version });
    }
  }
}

// ── Python ───────────────────────────────────

function extractPython(content, file, deps) {
  if (file === 'Pipfile.lock') {
    return extractPipfileLock(content, deps);
  }
  if (file === 'poetry.lock') {
    return extractPoetryLock(content, deps);
  }
  if (file === 'pyproject.toml') {
    return extractPyprojectToml(content, deps);
  }
  if (file === 'Pipfile') {
    return extractPipfile(content, deps);
  }
  // requirements.txt — support ==, >=, ~=, <=, !=
  const lines = content.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    // "package==1.0.0", "package>=1.0.0", "package~=1.0.0", "package<=1.0.0,>=0.9"
    const match = line.match(/^([a-zA-Z0-9_\-.]+)\s*[=~<>!]=?\s*([0-9][0-9a-zA-Z.*]*)/);
    if (match) deps.push({ name: match[1], version: match[2] });
  }
}

function extractPipfileLock(content, deps) {
  const lock = JSON.parse(content);
  for (const section of ['default', 'develop']) {
    const pkgs = lock[section] || {};
    for (const [name, info] of Object.entries(pkgs)) {
      const version = (info.version || '').replace(/^==/, '');
      if (version) deps.push({ name, version });
    }
  }
}

function extractPoetryLock(content, deps) {
  // TOML format: [[package]] blocks with name = "..." and version = "..."
  const blocks = content.split(/\[\[package\]\]/g).slice(1);
  for (const block of blocks) {
    const nameMatch = block.match(/^name\s*=\s*"([^"]+)"/m);
    const verMatch = block.match(/^version\s*=\s*"([^"]+)"/m);
    if (nameMatch && verMatch) {
      deps.push({ name: nameMatch[1], version: verMatch[1] });
    }
  }
}

function extractPyprojectToml(content, deps) {
  // [project] dependencies = ["pkg>=1.0", ...]
  // [tool.poetry.dependencies] pkg = "^1.0"
  const depLineRe = /["']([a-zA-Z0-9_\-.]+)\s*[=~<>!]=?\s*([0-9][0-9a-zA-Z.*]*).*?["']/g;
  let m;
  while ((m = depLineRe.exec(content)) !== null) {
    deps.push({ name: m[1], version: m[2] });
  }
}

function extractPipfile(content, deps) {
  // [packages] section: pkg = "==1.0" or pkg = {version = "==1.0", ...}
  const lines = content.split('\n');
  let inPackages = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[(packages|dev-packages)\]/.test(line)) { inPackages = true; continue; }
    if (/^\[/.test(line)) { inPackages = false; continue; }
    if (!inPackages) continue;
    // pkg = "==1.0.0" or pkg = ">=1.0"
    const match = line.match(/^([a-zA-Z0-9_\-.]+)\s*=\s*"[=~<>!]*([0-9][0-9a-zA-Z.]*)"/);
    if (match) deps.push({ name: match[1], version: match[2] });
    // pkg = {version = "==1.0.0"}
    const dictMatch = line.match(/^([a-zA-Z0-9_\-.]+)\s*=\s*\{.*?version\s*=\s*"[=~<>!]*([0-9][0-9a-zA-Z.]*)"/);
    if (dictMatch) deps.push({ name: dictMatch[1], version: dictMatch[2] });
  }
}

// ── Maven ────────────────────────────────────

function extractMaven(content, deps) {
  const props = parseMavenProperties(content);

  // Also extract parent version and managed dependency versions
  const managedVersions = parseDependencyManagement(content, props);

  // Extract all <dependency> blocks
  const blocks = content.split(/<dependency\s*>/i).slice(1);
  for (const block of blocks) {
    const end = block.indexOf('</dependency>');
    const inner = end >= 0 ? block.slice(0, end) : block;
    const groupId = getMavenTag(inner, 'groupId') || '';
    const artifactId = getMavenTag(inner, 'artifactId') || '';
    let version = getMavenTag(inner, 'version') || '';

    // Resolve property references
    version = resolveMavenProperty(version, props);

    // If no version, try dependencyManagement
    if (!version) {
      version = managedVersions[`${groupId}:${artifactId}`] || '';
    }

    // If still no version, try parent version
    if (!version) {
      version = props['project.version'] || props['project.parent.version'] || '';
    }

    if (groupId && artifactId && version && !version.includes('${')) {
      deps.push({ name: `${groupId}:${artifactId}`, version });
    }
  }

  // Extract parent POM as a dependency too (for vulnerability tracking)
  const parentBlock = content.match(/<parent\s*>[\s\S]*?<\/parent>/i);
  if (parentBlock) {
    const pGroupId = getMavenTag(parentBlock[0], 'groupId');
    const pArtifactId = getMavenTag(parentBlock[0], 'artifactId');
    let pVersion = getMavenTag(parentBlock[0], 'version');
    pVersion = resolveMavenProperty(pVersion, props);
    if (pGroupId && pArtifactId && pVersion && !pVersion.includes('${')) {
      deps.push({ name: `${pGroupId}:${pArtifactId}`, version: pVersion });
      // Store parent version for child resolution
      props['project.parent.version'] = pVersion;
    }
  }
}

function parseDependencyManagement(content, props) {
  const managed = {};
  const dmBlock = content.match(/<dependencyManagement\s*>[\s\S]*?<\/dependencyManagement>/i);
  if (!dmBlock) return managed;

  const blocks = dmBlock[0].split(/<dependency\s*>/i).slice(1);
  for (const block of blocks) {
    const end = block.indexOf('</dependency>');
    const inner = end >= 0 ? block.slice(0, end) : block;
    const groupId = getMavenTag(inner, 'groupId') || '';
    const artifactId = getMavenTag(inner, 'artifactId') || '';
    let version = getMavenTag(inner, 'version') || '';
    version = resolveMavenProperty(version, props);
    if (groupId && artifactId && version && !version.includes('${')) {
      managed[`${groupId}:${artifactId}`] = version;
    }
  }
  return managed;
}

function resolveMavenProperty(version, props) {
  if (!version) return '';
  // Iteratively resolve ${...} (max 3 depth to prevent loops)
  let resolved = version;
  for (let i = 0; i < 3; i++) {
    const m = resolved.match(/^\$\{([^}]+)\}$/);
    if (!m) break;
    resolved = props[m[1]] || resolved;
    if (resolved === version) break; // no change, stop
  }
  return resolved;
}

function getMavenTag(block, tag) {
  const re = new RegExp(`<${tag}\\s*>([^<]*)</${tag}>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function parseMavenProperties(pomContent) {
  const props = {};
  const re = /<([a-zA-Z][a-zA-Z0-9.\-_]*)\s*>([^<]*)<\/\1>/g;
  const propBlock = pomContent.match(/<properties\s*>[\s\S]*?<\/properties>/i);
  if (!propBlock) return props;
  let m;
  while ((m = re.exec(propBlock[0])) !== null) {
    props[m[1]] = m[2].trim();
  }
  return props;
}

// ── Gradle ───────────────────────────────────

function extractGradle(content, file, deps) {
  // Version catalog (libs.versions.toml)
  if (file === 'libs.versions.toml') {
    return extractGradleVersionCatalog(content, deps);
  }

  // All dependency configurations:
  // implementation, api, compileOnly, runtimeOnly, testImplementation, testRuntimeOnly,
  // annotationProcessor, kapt, ksp, provided
  const configs = [
    'implementation', 'api', 'compileOnly', 'runtimeOnly',
    'testImplementation', 'testRuntimeOnly', 'testCompileOnly',
    'annotationProcessor', 'kapt', 'ksp', 'provided', 'compile',
  ];
  const configPattern = configs.join('|');

  // Pattern 1: config("group:name:version") or config('group:name:version')
  const re1 = new RegExp(`(?:${configPattern})\\s*\\(?\\s*["']([^"']+)["']\\s*\\)?`, 'g');
  let m;
  while ((m = re1.exec(content)) !== null) {
    const parts = m[1].split(':');
    if (parts.length >= 3) {
      const version = parts[2].replace(/[\^~>=]/g, '').split(/[^0-9a-zA-Z.-]/)[0];
      if (version) deps.push({ name: `${parts[0]}:${parts[1]}`, version });
    }
  }

  // Pattern 2: config(group: "...", name: "...", version: "...")
  const re2 = new RegExp(
    `(?:${configPattern})\\s*\\(.*?group\\s*[:=]\\s*["']([^"']+)["'].*?name\\s*[:=]\\s*["']([^"']+)["'].*?version\\s*[:=]\\s*["']([^"']+)["']`,
    'gs'
  );
  while ((m = re2.exec(content)) !== null) {
    const version = m[3].replace(/[\^~>=]/g, '').split(/[^0-9a-zA-Z.-]/)[0];
    if (version) deps.push({ name: `${m[1]}:${m[2]}`, version });
  }

  // Pattern 3: Kotlin DSL — implementation(libs.bundles.xxx) or implementation(libs.xxx) → skip (no version inline)
  // These rely on version catalogs which need separate parsing

  // Deduplicate
  const seen = new Set();
  const unique = [];
  for (const d of deps) {
    const key = `${d.name}:${d.version}`;
    if (!seen.has(key)) { seen.add(key); unique.push(d); }
  }
  deps.length = 0;
  deps.push(...unique);
}

function extractGradleVersionCatalog(content, deps) {
  // [versions] section: key = "1.2.3"
  const versions = {};
  const versionSection = content.match(/\[versions\][\s\S]*?(?=\[|$)/);
  if (versionSection) {
    const re = /^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/gm;
    let m;
    while ((m = re.exec(versionSection[0])) !== null) {
      versions[m[1]] = m[2];
    }
  }

  // [libraries] section: key = { module = "group:name", version.ref = "key" } or key = "group:name:version"
  const libSection = content.match(/\[libraries\][\s\S]*?(?=\[|$)/);
  if (!libSection) return;
  const lines = libSection[0].split('\n');
  for (const line of lines) {
    // Inline: key = "group:name:version"
    const inlineMatch = line.match(/^\s*[a-zA-Z0-9_-]+\s*=\s*"([^"]+)"/);
    if (inlineMatch) {
      const parts = inlineMatch[1].split(':');
      if (parts.length >= 3 && parts[2]) {
        deps.push({ name: `${parts[0]}:${parts[1]}`, version: parts[2] });
        continue;
      }
    }
    // Table: module = "group:name", version.ref = "key" or version = "1.0"
    const moduleMatch = line.match(/module\s*=\s*"([^"]+)"/);
    const versionRefMatch = line.match(/version\.ref\s*=\s*"([^"]+)"/);
    const versionDirectMatch = line.match(/version\s*=\s*"([^"]+)"/);
    if (moduleMatch) {
      const parts = moduleMatch[1].split(':');
      let version = '';
      if (versionRefMatch) version = versions[versionRefMatch[1]] || '';
      else if (versionDirectMatch) version = versionDirectMatch[1];
      if (parts.length >= 2 && version) {
        deps.push({ name: `${parts[0]}:${parts[1]}`, version });
      }
    }
  }
}

// ── Go ───────────────────────────────────────

function extractGo(content, deps) {
  // go.mod format:
  // require github.com/pkg v1.0.0          (single-line)
  // require (
  //     github.com/pkg v1.0.0              (block)
  //     github.com/other v2.3.4
  // )

  // 1) Single-line requires
  const singleRe = /^require\s+(\S+)\s+(v?\S+)/gm;
  let m;
  while ((m = singleRe.exec(content)) !== null) {
    const name = m[1];
    const version = m[2].replace(/^v/, '').replace(/\/\/.*$/, '').trim();
    if (name && version) deps.push({ name, version });
  }

  // 2) Block requires
  const blockRe = /require\s*\(([\s\S]*?)\)/g;
  while ((m = blockRe.exec(content)) !== null) {
    const block = m[1];
    const lineRe = /^\s*(\S+)\s+(v?\S+)/gm;
    let lm;
    while ((lm = lineRe.exec(block)) !== null) {
      const name = lm[1];
      const version = lm[2].replace(/^v/, '').replace(/\/\/.*$/, '').trim();
      if (name && version && !name.startsWith('//')) {
        deps.push({ name, version });
      }
    }
  }
}

// ── Ruby ─────────────────────────────────────

function extractRuby(content, file, deps) {
  if (file === 'Gemfile.lock') {
    return extractGemfileLock(content, deps);
  }
  // Gemfile: gem "name", "~> 1.0"
  const re = /gem\s+["']([^"']+)["']\s*,\s*["'][~>=<]*\s*([0-9][0-9a-zA-Z.]*)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    deps.push({ name: m[1], version: m[2] });
  }
}

function extractGemfileLock(content, deps) {
  // GEM section → specs: → "    name (version)"
  const specsBlock = content.match(/specs:\n([\s\S]*?)(?=\n\S|\n\n)/);
  if (!specsBlock) return;
  const re = /^\s{4}(\S+)\s+\(([0-9][0-9a-zA-Z.]*)\)/gm;
  let m;
  while ((m = re.exec(specsBlock[1])) !== null) {
    deps.push({ name: m[1], version: m[2] });
  }
}

// ── PHP ──────────────────────────────────────

function extractPhp(content, file, deps) {
  if (file === 'composer.lock') {
    return extractComposerLock(content, deps);
  }
  // composer.json
  const pkg = JSON.parse(content);
  const allDeps = { ...(pkg.require || {}), ...(pkg['require-dev'] || {}) };
  for (const [name, version] of Object.entries(allDeps)) {
    if (name === 'php' || name.startsWith('ext-')) continue; // skip PHP itself and extensions
    const clean = (typeof version === 'string' ? version : '').replace(/[\^~>=<|!*\s]/g, '').split(',')[0];
    if (clean && /^\d/.test(clean)) deps.push({ name, version: clean });
  }
}

function extractComposerLock(content, deps) {
  const lock = JSON.parse(content);
  for (const section of ['packages', 'packages-dev']) {
    const pkgs = lock[section] || [];
    for (const pkg of pkgs) {
      if (pkg.name && pkg.version) {
        const version = pkg.version.replace(/^v/, '');
        deps.push({ name: pkg.name, version });
      }
    }
  }
}

// ── Rust ─────────────────────────────────────

function extractRust(content, file, deps) {
  if (file === 'Cargo.lock') {
    return extractCargoLock(content, deps);
  }
  // Cargo.toml: [dependencies] section
  // name = "version" or name = { version = "..." }
  const sections = content.split(/\[(?:dev-)?dependencies(?:\.[^\]]+)?\]/i).slice(1);
  for (const section of sections) {
    const end = section.indexOf('\n[');
    const block = end >= 0 ? section.slice(0, end) : section;
    const lines = block.split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      // name = "1.0.0"
      const simpleMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/);
      if (simpleMatch) {
        const version = simpleMatch[2].replace(/[\^~>=<]/g, '').split(',')[0].trim();
        if (/^\d/.test(version)) deps.push({ name: simpleMatch[1], version });
        continue;
      }
      // name = { version = "1.0.0", ... }
      const tableMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*\{.*?version\s*=\s*"([^"]+)"/);
      if (tableMatch) {
        const version = tableMatch[2].replace(/[\^~>=<]/g, '').split(',')[0].trim();
        if (/^\d/.test(version)) deps.push({ name: tableMatch[1], version });
      }
    }
  }
}

function extractCargoLock(content, deps) {
  const blocks = content.split(/\[\[package\]\]/g).slice(1);
  for (const block of blocks) {
    const nameMatch = block.match(/^name\s*=\s*"([^"]+)"/m);
    const verMatch = block.match(/^version\s*=\s*"([^"]+)"/m);
    if (nameMatch && verMatch) {
      deps.push({ name: nameMatch[1], version: verMatch[1] });
    }
  }
}

// ── NuGet (.NET) ─────────────────────────────

function extractNuget(content, file, deps) {
  if (file === 'packages.config') {
    // <package id="Name" version="1.0.0" />
    const re = /<package\s+[^>]*id="([^"]+)"[^>]*version="([^"]+)"/gi;
    let m;
    while ((m = re.exec(content)) !== null) {
      deps.push({ name: m[1], version: m[2] });
    }
  }
  // .csproj: <PackageReference Include="Name" Version="1.0.0" />
  if (file.endsWith('.csproj') || file.endsWith('.fsproj') || file.endsWith('.vbproj')) {
    const re = /<PackageReference\s+[^>]*Include="([^"]+)"[^>]*Version="([^"]+)"/gi;
    let m;
    while ((m = re.exec(content)) !== null) {
      deps.push({ name: m[1], version: m[2] });
    }
  }
}

// ── Dart/Flutter ─────────────────────────────

function extractDart(content, file, deps) {
  if (file === 'pubspec.lock') {
    // YAML-ish: "  name:\n    ...\n    version: \"1.0.0\""
    const blocks = content.split(/\n  \S/);
    for (const block of blocks) {
      const nameMatch = block.match(/^([a-zA-Z0-9_-]+):/m);
      const verMatch = block.match(/version:\s*"([^"]+)"/);
      if (nameMatch && verMatch) {
        deps.push({ name: nameMatch[1], version: verMatch[1] });
      }
    }
    return;
  }
  // pubspec.yaml: dependencies section
  const lines = content.split('\n');
  let inDeps = false;
  for (const raw of lines) {
    const line = raw;
    if (/^(dependencies|dev_dependencies):/.test(line)) { inDeps = true; continue; }
    if (/^\S/.test(line)) { inDeps = false; continue; }
    if (!inDeps) continue;
    // "  package: ^1.0.0" or "  package: 1.0.0"
    const match = line.match(/^\s{2}([a-zA-Z0-9_]+):\s*[\^~>=]*([0-9][0-9a-zA-Z.]*)/);
    if (match) deps.push({ name: match[1], version: match[2] });
  }
}

// ── Helpers ──────────────────────────────────

function cleanSemver(version) {
  return version.replace(/[\^~>=<]/g, '').split(/[\s,]/)[0] || '';
}

// ═════════════════════════════════════════════
// OSV API QUERY
// ═════════════════════════════════════════════

/**
 * [목적] OSV.dev API를 사용하여 의존성 취약점 조회.
 *
 * [exported] scripts/osv-scanner.mjs에서도 사용
 */
export async function queryOsvBatch(deps, ecosystemType, sourceDir) {
  const vulns = [];

  const ecosystem = OSV_ECOSYSTEM_MAP[ecosystemType];
  if (!ecosystem) return [];

  const targetDeps = deps.slice(0, 500);

  for (const dep of targetDeps) {
    try {
      const query = {
        version: dep.version,
        package: {
          name: dep.name,
          ecosystem: ecosystem
        }
      };

      // 🔍 Log the outbound request for security auditing
      const projectName = path.basename(sourceDir);
      const timestamp = getLogTimestamp();
      const logEntry = `[${timestamp}] Project: ${projectName} | OSV Request: ecosystem=${ecosystem}, package=${dep.name}, version=${dep.version}\n`;
      try {
        const osvLogDir = path.join(DOKODEMODOOR_ROOT, 'osv-logs');
        if (!await fs.pathExists(osvLogDir)) await fs.ensureDir(osvLogDir);
        await fs.appendFile(path.join(osvLogDir, 'outbound_osv_requests.log'), logEntry);
      } catch (err) {
        // Silently continue if logging fails
      }

      const response = await $`curl -s -X POST -d ${JSON.stringify(query)} https://api.osv.dev/v1/query`;
      const data = JSON.parse(response.stdout);

      if (data.vulns && data.vulns.length > 0) {
        vulns.push({
          package: dep.name,
          version: dep.version,
          vulnerabilities: data.vulns.map(v => ({
            id: v.id,
            summary: v.summary,
            details: v.details?.substring(0, 1000),
            published: v.published
          }))
        });
      }
    } catch (error) {
      // Silently continue on individual query failures
    }
  }

  return vulns;
}
