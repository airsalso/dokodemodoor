#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { $ } from 'zx';
import chalk from 'chalk';
import { getLogTimestamp } from '../src/utils/time-utils.js';

const [repoPathArg] = process.argv.slice(2);

if (!repoPathArg) {
  console.error(chalk.red('Usage: node scripts/osv-scanner.mjs <repo_path>'));
  process.exit(1);
}

const repoPath = path.resolve(repoPathArg);
const deliverableDir = path.join(repoPath, 'deliverables');
const outputPath = path.join(deliverableDir, 'osv_analysis_deliverable.md');

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

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
    if (await pathExists(filePath)) {
      ecosystems.push({ ...check, path: filePath });
    }
  }
  return ecosystems;
}

async function extractDependencies(ecosystem) {
  const deps = [];
  try {
    if (ecosystem.type === 'npm') {
      const content = JSON.parse(await fs.readFile(ecosystem.path, 'utf8'));
      const allDeps = { ...(content.dependencies || {}), ...(content.devDependencies || {}) };
      for (const [name, version] of Object.entries(allDeps)) {
        const cleanVersion = version.replace(/[\^~>=]/g, '').split(' ')[0];
        deps.push({ name, version: cleanVersion });
      }
    } else if (ecosystem.type === 'pip') {
      const content = await fs.readFile(ecosystem.path, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const match = line.match(/^([a-zA-Z0-9_\-]+)==([0-9\.]+)$/);
        if (match) deps.push({ name: match[1], version: match[2] });
      }
    }
  } catch (error) {
    console.log(chalk.yellow(`   ⚠️ Failed to extract ${ecosystem.type} dependencies: ${error.message}`));
  }
  return deps;
}

async function queryOsv(dep, ecosystemType) {
  const OSV_ECOSYSTEM_MAP = { npm: 'npm', pip: 'PyPI', maven: 'Maven', gradle: 'Maven', go: 'Go' };
  const ecosystem = OSV_ECOSYSTEM_MAP[ecosystemType];
  if (!ecosystem) return null;

  try {
    const query = { version: dep.version, package: { name: dep.name, ecosystem } };

    // 🔍 Log the outbound request for security auditing
    const projectName = path.basename(repoPath);
    const timestamp = getLogTimestamp();
    const logEntry = `[${timestamp}] Project: ${projectName} | (Standalone) OSV Request: ecosystem=${ecosystem}, package=${dep.name}, version=${dep.version}\n`;
    try {
      const osvLogDir = path.resolve('osv-logs');
      if (!await pathExists(osvLogDir)) await fs.mkdir(osvLogDir, { recursive: true });
      await fs.appendFile(path.join(osvLogDir, 'outbound_osv_requests.log'), logEntry);
    } catch (err) {}

    const response = await $`curl -s -X POST -d ${JSON.stringify(query)} https://api.osv.dev/v1/query`;
    const data = JSON.parse(response.stdout);
    if (data.vulns && data.vulns.length > 0) {
      return {
        package: dep.name,
        version: dep.version,
        vulnerabilities: data.vulns.map(v => ({ id: v.id, summary: v.summary }))
      };
    }
  } catch (e) {}
  return null;
}

async function main() {
  console.log(chalk.cyan(`🚀 Starting OSV (SCA) Analysis via API: ${repoPath}`));
  await fs.mkdir(deliverableDir, { recursive: true });

  const ecosystems = await detectEcosystems(repoPath);
  let report = '# OSV Security Analysis (SCA)\n\n';
  report += `Analysis Date: ${new Date().toISOString()}\n\n`;

  if (ecosystems.length === 0) {
    report += '⚠️ No supported ecosystems detected.\n';
  } else {
    const allFindings = [];
    for (const eco of ecosystems) {
      console.log(chalk.blue(`🔍 Checking ${eco.type} dependencies...`));
      const deps = await extractDependencies(eco);
      for (const dep of deps.slice(0, 500)) {
        const result = await queryOsv(dep, eco.type);
        if (result) allFindings.push(result);
      }
    }

    if (allFindings.length === 0) {
      report += '✅ No known vulnerabilities found in monitored dependencies.\n';
    } else {
      report += '## 🚨 Discovered Vulnerabilities\n\n';
      report += '| Package | Version | Vulnerability ID | Summary |\n';
      report += '| :--- | :--- | :--- | :--- |\n';
      for (const f of allFindings) {
        for (const v of f.vulnerabilities) {
          report += `| ${f.package} | ${f.version} | [${v.id}](https://osv.dev/vulnerability/${v.id}) | ${v.summary} |\n`;
        }
      }
    }
  }

  await fs.writeFile(outputPath, report, 'utf8');
  console.log(chalk.green(`✅ OSV deliverable saved: ${outputPath}`));
}

main().catch(err => {
  console.error(chalk.red('Fatal Error:'), err);
  process.exit(1);
});
