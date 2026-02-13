import { fs, path } from 'zx';
import chalk from 'chalk';

/**
 * [목적] 기존 exploitation queue 파일들을 읽어서 이미 발견된 취약점 정보를 추출.
 *
 * [호출자]
 * - executePreReconPhase() - 프롬프트 변수 생성 시
 *
 * [입력 파라미터]
 * - sourceDir (string): 소스 디렉토리 경로
 *
 * [반환값]
 * - Promise<object>: {
 *     summary: string,           // 프롬프트에 주입할 요약 텍스트
 *     analyzedFiles: string[],   // 이미 분석된 파일 목록
 *     vulnerabilityTypes: Set,   // 발견된 취약점 타입들
 *     totalCount: number         // 총 발견된 취약점 수
 *   }
 */
export async function loadPreviousVulnerabilities(sourceDir) {
  const deliverablesDir = path.join(sourceDir, 'deliverables');
  const queuePattern = /_exploitation_queue\.json$/;

  const result = {
    summary: '',
    analyzedFiles: new Set(),
    vulnerabilityTypes: new Set(),
    totalCount: 0,
    byType: {}
  };

  try {
    // Collect all potential deliverables directories
    const deliverablesDirs = [];

    // 1. Current deliverables directory
    if (await fs.pathExists(deliverablesDir)) {
      deliverablesDirs.push({ path: deliverablesDir, label: 'current' });
    }

    // 2. Archived deliverables directories (deliverables__*)
    const parentDir = path.dirname(deliverablesDir);
    const allEntries = await fs.readdir(parentDir);
    const archivedDirs = allEntries.filter(entry => entry.startsWith('deliverables__'));

    for (const archivedDir of archivedDirs) {
      const fullPath = path.join(parentDir, archivedDir);
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        deliverablesDirs.push({ path: fullPath, label: archivedDir });
      }
    }

    if (deliverablesDirs.length === 0) {
      console.log(chalk.gray('    ℹ️  No previous scan data found (first run)'));
      return {
        summary: '**FIRST SCAN**: No previous vulnerabilities found. Perform comprehensive analysis of all code areas.',
        analyzedFiles: [],
        vulnerabilityTypes: new Set(),
        totalCount: 0,
        byType: {}
      };
    }

    console.log(chalk.blue(`    📂 Searching ${deliverablesDirs.length} deliverables location(s) for previous results...`));

    // Read all queue files from all deliverables directories
    const allQueueFiles = [];
    for (const dir of deliverablesDirs) {
      try {
        const files = await fs.readdir(dir.path);
        const queueFiles = files.filter(f => queuePattern.test(f));
        queueFiles.forEach(file => {
          allQueueFiles.push({
            path: path.join(dir.path, file),
            name: file,
            source: dir.label
          });
        });
      } catch (err) {
        console.log(chalk.yellow(`    ⚠️  Could not read ${dir.label}: ${err.message}`));
      }
    }

    if (allQueueFiles.length === 0) {
      console.log(chalk.gray('    ℹ️  No previous exploitation queues found (first run)'));
      return {
        summary: '**FIRST SCAN**: No previous vulnerabilities found. Perform comprehensive analysis of all code areas.',
        analyzedFiles: [],
        vulnerabilityTypes: new Set(),
        totalCount: 0,
        byType: {}
      };
    }

    console.log(chalk.blue(`    📂 Found ${allQueueFiles.length} previous exploitation queue(s) across all scans`));

    // Load and parse each queue file
    for (const queueFile of allQueueFiles) {
      const vulnType = queueFile.name.replace('_exploitation_queue.json', '').toUpperCase();

      try {
        const content = await fs.readFile(queueFile.path, 'utf8');
        const queue = JSON.parse(content);

        if (!queue.vulnerabilities || !Array.isArray(queue.vulnerabilities)) {
          continue;
        }

        const vulnCount = queue.vulnerabilities.length;
        result.totalCount += vulnCount;
        result.vulnerabilityTypes.add(vulnType);
        result.byType[vulnType] = (result.byType[vulnType] || 0) + vulnCount;

        // Extract analyzed file paths (with fallback for categories without 'path' field)
        queue.vulnerabilities.forEach(vuln => {
          const filePath = vuln.path
            || vuln.vulnerable_code_location
            || vuln.source_endpoint
            || vuln.source
            || vuln.endpoint;
          if (filePath) {
            result.analyzedFiles.add(filePath);
          }
        });

        console.log(chalk.gray(`       → ${vulnType} (${queueFile.source}): ${vulnCount} vulnerabilities`));
      } catch (err) {
        console.log(chalk.yellow(`    ⚠️  Failed to parse ${queueFile.name}: ${err.message}`));
      }
    }

    // Build summary text for prompt injection
    const analyzedFilesArray = Array.from(result.analyzedFiles);
    const vulnTypesArray = Array.from(result.vulnerabilityTypes);

    let summary = `## 🔄 CUMULATIVE ANALYSIS MODE (Previous Scan Context)\n\n`;
    summary += `### Previously Discovered Vulnerabilities\n\n`;
    summary += `**Total**: ${result.totalCount} vulnerabilities found across ${Object.keys(result.byType).length} categories\n\n`;

    summary += `**By Type**:\n`;
    vulnTypesArray.forEach(type => {
      summary += `- **${type}**: ${result.byType[type]} vulnerabilities\n`;
    });

    summary += `\n**Analyzed Files** (${analyzedFilesArray.length} files):\n`;
    if (analyzedFilesArray.length > 0) {
      // Show first 20 files, then summarize
      const displayFiles = analyzedFilesArray.slice(0, 20);
      displayFiles.forEach(file => {
        summary += `- \`${file}\`\n`;
      });
      if (analyzedFilesArray.length > 20) {
        summary += `- ... and ${analyzedFilesArray.length - 20} more files\n`;
      }
    }

    summary += `\n### Analysis Directives for This Scan\n\n`;
    summary += `**PRIMARY FOCUS** (Unexplored Areas):\n`;
    summary += `1. **New File Discovery**: Prioritize files NOT in the analyzed list above\n`;
    summary += `2. **Different Vulnerability Types**: If ${vulnTypesArray.join(', ')} were found, look for OTHER types (e.g., logic flaws, business logic bypasses)\n`;
    summary += `3. **Adjacent Code Paths**: Explore functions NEAR previously flagged code (same file, different functions)\n`;
    summary += `4. **Alternative Entry Points**: Focus on unexplored endpoints, webhooks, admin routes, etc.\n\n`;

    summary += `**SECONDARY FOCUS** (Re-analysis with New Perspective):\n`;
    summary += `- Previously analyzed files MAY be re-examined if you suspect:\n`;
    summary += `  - A different vulnerability type (e.g., found SQLi before, now check for IDOR)\n`;
    summary += `  - Complex logic flaws not detectable by pattern matching\n`;
    summary += `  - Multi-step attack chains involving previously flagged code\n\n`;

    summary += `**STRICT EXCLUSION** (Do NOT re-report):\n`;
    summary += `- Do NOT report the EXACT SAME vulnerability (same file:line + same type)\n`;
    summary += `- Focus on EXPANDING coverage, not duplicating previous findings\n\n`;

    summary += `**Coverage Tracking**:\n`;
    summary += `- Analyzed files: ${analyzedFilesArray.length} files\n`;
    summary += `- Your goal: Find vulnerabilities in NEW files or NEW types in existing files\n`;

    result.summary = summary;
    result.analyzedFiles = analyzedFilesArray;

    console.log(chalk.green(`    ✅ Loaded context from ${result.totalCount} previous vulnerabilities`));

    return result;

  } catch (error) {
    console.log(chalk.yellow(`    ⚠️  Error loading previous vulnerabilities: ${error.message}`));
    return {
      summary: '**ERROR**: Could not load previous scan data. Perform comprehensive analysis.',
      analyzedFiles: [],
      vulnerabilityTypes: new Set(),
      totalCount: 0,
      byType: {}
    };
  }
}

/**
 * [목적] 이미 분석된 디렉토리를 파악하여 미탐색 영역 추천.
 *
 * [호출자]
 * - loadPreviousVulnerabilities() 내부 또는 별도 호출
 *
 * [입력 파라미터]
 * - analyzedFiles (string[]): 이미 분석된 파일 목록
 * - sourceDir (string): 소스 디렉토리
 *
 * [반환값]
 * - Promise<string[]>: 미탐색 디렉토리 목록
 */
export async function identifyUnexploredDirectories(analyzedFiles, sourceDir) {
  try {
    // Get all directories in source
    const allDirs = new Set();

    // Extract directories from analyzed files
    const analyzedDirs = new Set();
    analyzedFiles.forEach(file => {
      const dir = path.dirname(file);
      const parts = dir.split(path.sep);
      // Add all parent directories
      for (let i = 1; i <= parts.length; i++) {
        analyzedDirs.add(parts.slice(0, i).join(path.sep));
      }
    });

    // Common source directories to check
    const commonDirs = [
      'src', 'lib', 'routes', 'controllers', 'models', 'services',
      'api', 'middleware', 'handlers', 'utils', 'helpers', 'components'
    ];

    const unexplored = [];
    for (const dir of commonDirs) {
      const fullPath = path.join(sourceDir, dir);
      if (await fs.pathExists(fullPath)) {
        allDirs.add(dir);
        if (!analyzedDirs.has(dir)) {
          unexplored.push(dir);
        }
      }
    }

    return unexplored;
  } catch (error) {
    console.log(chalk.yellow(`    ⚠️  Error identifying unexplored directories: ${error.message}`));
    return [];
  }
}
