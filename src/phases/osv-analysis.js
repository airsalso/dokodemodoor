import { fs, path, $ } from 'zx';
import chalk from 'chalk';
import { PentestError } from '../error-handling.js';
import { getAgentName, getTargetDir } from '../utils/context.js';
import { getLogTimestamp } from '../utils/time-utils.js';

/**
 * [목적] 오픈소스 취약점 분석(SCA) 단계 수행.
 *
 * [호출자]
 * - osv-scanner.mjs
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
    console.log(chalk.yellow('⚠️  No supported ecosystems (npm, pip, maven, etc.) detected.'));
    return { success: true, message: 'No ecosystems detected' };
  }

  console.log(chalk.blue(`📂 Detected ecosystems: ${ecosystems.map(e => e.type).join(', ')}`));

  // 2. Dependency Extraction & OSV Query
  const allVulnerabilities = [];
  for (const ecosystem of ecosystems) {
    console.log(chalk.gray(`   Processing ${ecosystem.type} dependencies...`));
    const deps = await extractDependencies(ecosystem);
    const vulns = await queryOsvBatch(deps, ecosystem.type, sourceDir);
    allVulnerabilities.push(...vulns);
  }

  if (allVulnerabilities.length === 0) {
    console.log(chalk.green('✅ No known vulnerabilities found in open source dependencies.'));
    // We still run the agent to provide a clean report if needed, or just exit
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
    'Read,Web', // Allow Read and Web Search
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

        // Match headers like ### Package (CVE-ID) or ### Package [CVE-ID]
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

/**
 * Detects manifest files for various ecosystems.
 */
async function detectEcosystems(sourceDir) {
  const ecosystems = [];
  const checks = [
    { type: 'npm', file: 'package.json' },
    { type: 'pip', file: 'requirements.txt' },
    { type: 'maven', file: 'pom.xml' },
    { type: 'gradle', file: 'build.gradle' },
    { type: 'go', file: 'go.mod' }
  ];

  for (const check of checks) {
    const filePath = path.join(sourceDir, check.file);
    if (await fs.pathExists(filePath)) {
      ecosystems.push({ ...check, path: filePath });
    }
  }

  return ecosystems;
}

/**
 * Extracts dependency metadata (name, version) from manifest files.
 * This implementation is simplified and can be extended for each ecosystem.
 */
async function extractDependencies(ecosystem) {
  const deps = [];
  try {
    if (ecosystem.type === 'npm') {
      const content = await fs.readJson(ecosystem.path);
      const allDeps = { ...(content.dependencies || {}), ...(content.devDependencies || {}) };
      for (const [name, version] of Object.entries(allDeps)) {
        // Clean version string (remove ^, ~, etc.)
        const cleanVersion = version.replace(/[\^~>=]/g, '').split(' ')[0];
        deps.push({ name, version: cleanVersion });
      }
    } else if (ecosystem.type === 'pip') {
      const content = await fs.readFile(ecosystem.path, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const match = line.match(/^([a-zA-Z0-9_\-]+)==([0-9\.]+)$/);
        if (match) {
          deps.push({ name: match[1], version: match[2] });
        }
      }
    }
    // Add more ecosystems here...
  } catch (error) {
    console.log(chalk.yellow(`   ⚠️ Failed to extract dependencies from ${ecosystem.path}: ${error.message}`));
  }
  return deps;
}

/**
 * Queries OSV.dev API for a list of dependencies.
 * Uses metadata-only to preserve privacy.
 */
async function queryOsvBatch(deps, ecosystemType, sourceDir) {
  // OSV.dev API expects batch queries in a specific format
  // For simplicity and to avoid large payloads, we query them in smaller batches or individually
  const vulns = [];
  const OSV_ECOSYSTEM_MAP = {
    npm: 'npm',
    pip: 'PyPI',
    maven: 'Maven',
    gradle: 'Maven',
    go: 'Go'
  };

  const ecosystem = OSV_ECOSYSTEM_MAP[ecosystemType];
  if (!ecosystem) return [];

  // Limit to first 500 dependencies for the demo/initial version to prevent rate limiting or huge logs
  const targetDeps = deps.slice(0, 500);

  for (const dep of targetDeps) {
    try {
      // Query OSV API via curl to keep it lightweight and avoid new npm dependencies
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
        const osvLogDir = path.join(process.cwd(), 'osv-logs');
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
            details: v.details?.substring(0, 1000), // Truncate very long details to save prompt tokens
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
