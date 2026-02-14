#!/usr/bin/env node
/**
 * [목적] Pre-recon에서 사용하는 "scan-only" OSV 스캐너.
 * - OSV.dev API로 의존성 취약점 정보를 조회하고 Markdown 리포트만 생성한다.
 * - AI 분석(LLM)은 수행하지 않는다. (그건 osv-analysis phase에서 수행)
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

const MAX_ROWS = (() => {
  const raw = process.env.DOKODEMODOOR_OSV_REPORT_MAX_ROWS;
  const n = raw ? parseInt(raw, 10) : 600;
  return Number.isFinite(n) && n > 0 ? n : 600;
})();

async function main() {
  console.log(chalk.cyan(`🚀 Starting OSV scan-only (API) for: ${repoPath}`));
  await fs.mkdir(deliverableDir, { recursive: true });

  const ecosystems = await detectEcosystems(repoPath);
  let report = '# Open Source Vulnerability Scan (OSV.dev)\n\n';
  report += `Scan Date: ${new Date().toISOString()}\n`;
  report += `Mode: scan-only (no AI analysis)\n\n`;
  report += '## Detected Manifests\n\n';

  if (ecosystems.length === 0) {
    report += '⚠️ No supported ecosystems detected.\n\n';
    report += 'Supported (best-effort): npm, pip, maven, gradle, go, ruby, php, rust, nuget, dart\n';
    console.log(chalk.yellow('⚠️  No supported ecosystems detected.'));
  } else {
    const types = [...new Set(ecosystems.map(e => e.type))];
    console.log(chalk.blue(`📂 Detected ecosystems: ${types.join(', ')} (${ecosystems.length} manifest(s))`));

    report += '| Ecosystem | File | Path |\n';
    report += '| :--- | :--- | :--- |\n';
    for (const eco of ecosystems) {
      const rel = path.relative(repoPath, eco.path);
      report += `| ${eco.type} | \`${eco.file}\` | \`${rel}\` |\n`;
    }
    report += '\n';

    report += '## Extraction Summary\n\n';

    const allFindings = [];
    const extractionStats = [];
    for (const eco of ecosystems) {
      console.log(chalk.gray(`   Processing ${eco.type} (${eco.file}) ...`));
      const deps = await extractDependencies(eco);
      if (deps.length === 0) {
        console.log(chalk.gray(`     → 0 dependencies extracted, skipping`));
        extractionStats.push({
          type: eco.type,
          file: eco.file,
          depCount: 0,
          vulnPkgCount: 0,
          vulnCount: 0
        });
        continue;
      }
      console.log(chalk.gray(`     → ${deps.length} dependencies extracted`));
      const vulns = await queryOsvBatch(deps, eco.type, repoPath);
      allFindings.push(...vulns);

      const vulnCount = vulns.reduce((acc, curr) => acc + (curr.vulnerabilities?.length || 0), 0);
      extractionStats.push({
        type: eco.type,
        file: eco.file,
        depCount: deps.length,
        vulnPkgCount: vulns.length,
        vulnCount
      });
    }

    if (allFindings.length === 0) {
      report += '| Ecosystem | File | Deps Extracted | Vulnerable Packages | Vulnerabilities |\n';
      report += '| :--- | :--- | ---: | ---: | ---: |\n';
      for (const s of extractionStats) {
        report += `| ${s.type} | \`${s.file}\` | ${s.depCount} | ${s.vulnPkgCount} | ${s.vulnCount} |\n`;
      }
      report += '\n';

      report += '✅ No known vulnerabilities found in monitored dependencies.\n';
      console.log(chalk.green('✅ No known vulnerabilities found.'));
    } else {
      const totalVulnCount = allFindings.reduce((acc, curr) => acc + (curr.vulnerabilities?.length || 0), 0);
      console.log(chalk.red(`🚨 Found ${totalVulnCount} individual vulnerabilities across ${allFindings.length} packages.`));

      report += '| Ecosystem | File | Deps Extracted | Vulnerable Packages | Vulnerabilities |\n';
      report += '| :--- | :--- | ---: | ---: | ---: |\n';
      for (const s of extractionStats) {
        report += `| ${s.type} | \`${s.file}\` | ${s.depCount} | ${s.vulnPkgCount} | ${s.vulnCount} |\n`;
      }
      report += '\n';

      report += '## 🚨 Discovered Vulnerabilities\n\n';
      report += '| Package | Version | Vulnerability ID | Published | Summary |\n';
      report += '| :--- | :--- | :--- | :--- | :--- |\n';

      let rows = 0;
      for (const f of allFindings) {
        for (const v of f.vulnerabilities) {
          if (rows >= MAX_ROWS) break;
          const published = v.published ? String(v.published).slice(0, 10) : '';
          const summary = (v.summary || '').replace(/\r?\n/g, ' ').slice(0, 200);
          report += `| ${f.package} | ${f.version} | [${v.id}](https://osv.dev/vulnerability/${v.id}) | ${published} | ${summary} |\n`;
          rows += 1;
        }
        if (rows >= MAX_ROWS) break;
      }

      if (rows >= MAX_ROWS) {
        report += `\n⚠️ Output truncated to ${MAX_ROWS} rows. Set \`DOKODEMODOOR_OSV_REPORT_MAX_ROWS\` to increase.\n`;
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
