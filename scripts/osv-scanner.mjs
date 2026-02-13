#!/usr/bin/env node
/**
 * [목적] 독립 실행 OSV 스캐너 — src/phases/osv-analysis.js의 공유 함수를 재사용.
 *
 * 사용법: node scripts/osv-scanner.mjs <repo_path>
 */
import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { detectEcosystems, extractDependencies, queryOsvBatch } from '../src/phases/osv-analysis.js';

const [repoPathArg] = process.argv.slice(2);

if (!repoPathArg) {
  console.error(chalk.red('Usage: node scripts/osv-scanner.mjs <repo_path>'));
  process.exit(1);
}

const repoPath = path.resolve(repoPathArg);
const deliverableDir = path.join(repoPath, 'deliverables');
const outputPath = path.join(deliverableDir, 'osv_analysis_deliverable.md');

async function main() {
  console.log(chalk.cyan(`🚀 Starting Open Source Vulnerability Analysis via API: ${repoPath}`));
  await fs.mkdir(deliverableDir, { recursive: true });

  const ecosystems = await detectEcosystems(repoPath);
  let report = '# Open Source Vulnerability Analysis\n\n';
  report += `Analysis Date: ${new Date().toISOString()}\n\n`;

  if (ecosystems.length === 0) {
    report += '⚠️ No supported ecosystems detected.\n';
    console.log(chalk.yellow('⚠️  No supported ecosystems detected.'));
  } else {
    const types = [...new Set(ecosystems.map(e => e.type))];
    console.log(chalk.blue(`📂 Detected ecosystems: ${types.join(', ')} (${ecosystems.length} manifest(s))`));

    const allFindings = [];
    for (const eco of ecosystems) {
      console.log(chalk.gray(`   Processing ${eco.type} (${eco.file}) ...`));
      const deps = await extractDependencies(eco);
      if (deps.length === 0) {
        console.log(chalk.gray(`     → 0 dependencies extracted, skipping`));
        continue;
      }
      console.log(chalk.gray(`     → ${deps.length} dependencies extracted`));
      const vulns = await queryOsvBatch(deps, eco.type, repoPath);
      allFindings.push(...vulns);
    }

    if (allFindings.length === 0) {
      report += '✅ No known vulnerabilities found in monitored dependencies.\n';
      console.log(chalk.green('✅ No known vulnerabilities found.'));
    } else {
      const totalVulnCount = allFindings.reduce((acc, curr) => acc + (curr.vulnerabilities?.length || 0), 0);
      console.log(chalk.red(`🚨 Found ${totalVulnCount} individual vulnerabilities across ${allFindings.length} packages.`));

      report += '## 🚨 Discovered Vulnerabilities\n\n';
      report += '| Package | Version | Vulnerability ID | Summary |\n';
      report += '| :--- | :--- | :--- | :--- |\n';
      for (const f of allFindings) {
        for (const v of f.vulnerabilities) {
          report += `| ${f.package} | ${f.version} | [${v.id}](https://osv.dev/vulnerability/${v.id}) | ${v.summary || ''} |\n`;
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
