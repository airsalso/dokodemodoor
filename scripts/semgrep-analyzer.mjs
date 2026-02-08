#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { $ } from 'zx';
import chalk from 'chalk';

const [repoPathArg] = process.argv.slice(2);

if (!repoPathArg) {
  console.error(chalk.red('Usage: node scripts/semgrep-analyzer.mjs <repo_path>'));
  process.exit(1);
}

const repoPath = path.resolve(repoPathArg);
const deliverableDir = path.join(repoPath, 'deliverables');
const outputPath = path.join(deliverableDir, 'semgrep_analysis_deliverable.md');

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const langRulesets = {
  'javascript': ['p/javascript', 'p/security-audit', 'p/secrets'],
  'typescript': ['p/typescript', 'p/javascript', 'p/security-audit', 'p/secrets'],
  'python': ['p/python', 'p/security-audit', 'p/secrets'],
  'java': ['p/java', 'p/security-audit', 'p/secrets', 'p/owasp-top-10'],
  'go': ['p/go', 'p/security-audit', 'p/secrets']
};

async function detectLanguages(repoPath) {
  const langs = new Set();
  if (await pathExists(path.join(repoPath, 'package.json'))) {
    langs.add('javascript');
    // Check if it's likely typescript
    const files = await fs.readdir(repoPath, { recursive: true }).catch(() => []);
    if (files.some(f => f.endsWith('.ts') || f.endsWith('.tsx'))) {
      langs.add('typescript');
    }
  }
  if (await pathExists(path.join(repoPath, 'requirements.txt')) || await pathExists(path.join(repoPath, 'manage.py'))) langs.add('python');
  if (await pathExists(path.join(repoPath, 'pom.xml')) || await pathExists(path.join(repoPath, 'build.gradle'))) langs.add('java');
  if (await pathExists(path.join(repoPath, 'go.mod'))) langs.add('go');

  return Array.from(langs);
}

async function main() {
  console.log(chalk.cyan(`🚀 Starting Professional Semgrep Audit on: ${repoPath}`));

  await fs.mkdir(deliverableDir, { recursive: true });

  const targetLangs = await detectLanguages(repoPath);
  console.log(chalk.gray(`📡 Detected languages: ${targetLangs.length > 0 ? targetLangs.join(', ') : 'None (using generic audit)'}`));

  let configs = ['p/default']; // Start with default
  targetLangs.forEach(lang => {
    if (langRulesets[lang]) {
      configs.push(...langRulesets[lang]);
    }
  });

  // Unique configs
  configs = [...new Set(configs)];
  const configArgs = configs.flatMap(c => ['--config', c]);

  console.log(chalk.blue(`🔍 Scanning with official rulesets: ${configs.join(', ')}...`));

  let result;
  try {
    // We use --quiet and --json. --error to not fail on findings.
    result = await $({ silent: true })`semgrep scan --json ${configArgs} --quiet --error ${repoPath}`;
  } catch (error) {
    // Semgrep exits with non-zero if findings are found by default, zx throws.
    // But we check if stdout has content.
    if (error.stdout) {
      result = error;
    } else {
      console.error(chalk.red('Fatal Error during Semgrep execution:'), error.stderr || error.message);
      process.exit(1);
    }
  }

  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (e) {
    console.error(chalk.red('Failed to parse Semgrep output:'), e.message);
    process.exit(1);
  }

  const results = data.results || [];
  console.log(chalk.green(`✅ Scanned completed. Found ${results.length} issues.`));

  let report = '# Semgrep Security Audit Report (Official Rulesets)\n\n';
  report += `Analysis Date: ${new Date().toISOString()}\n`;
  report += `Target Repository: ${repoPath}\n`;
  report += `Rulesets Applied: ${configs.join(', ')}\n\n`;

  if (results.length === 0) {
    report += '✅ No security issues discovered by Semgrep official rulesets.\n';
  } else {
    report += `## 🚨 Found ${results.length} Potential Vulnerabilities\n\n`;
    report += 'The following issues were identified using community-verified security patterns.\n\n';

    // Group by check_id
    const grouped = {};
    results.forEach(r => {
      const id = r.check_id;
      if (!grouped[id]) grouped[id] = {
        description: r.extra?.message || 'No description provided',
        severity: r.extra?.severity || 'UNKNOWN',
        lines: []
      };
      grouped[id].lines.push({
        path: r.path,
        line: r.start.line
      });
    });

    for (const [checkId, info] of Object.entries(grouped)) {
      report += `### [${checkId}] (${info.severity})\n`;
      report += `**Description:** ${info.description}\n\n`;

      const byFile = {};
      info.lines.forEach(l => {
        if (!byFile[l.path]) byFile[l.path] = [];
        byFile[l.path].push(l.line);
      });

      report += '| File Path | Lines |\n';
      report += '| :--- | :--- |\n';
      // Limit to top 15 files per check to avoid massive reports
      const files = Object.keys(byFile);
      for (const file of files.slice(0, 15)) {
        const relPath = path.relative(repoPath, file);
        report += `| \`${relPath}\` | ${byFile[file].sort((a,b)=>a-b).join(', ')} |\n`;
      }
      if (files.length > 15) {
        report += `| ... and ${files.length - 15} more files | |\n`;
      }
      report += '\n';
    }
  }

  report += '---\n';
  report += '**Note to AI Agent:** This report contains findings from professional security rulesets. Prioritize investigating High/Error severity issues. Use these as entry points for deep logic analysis.\n';

  await fs.writeFile(outputPath, report, 'utf8');
  console.log(chalk.green(`✅ Semgrep analysis deliverable saved to: ${outputPath}`));
}

main().catch(err => {
  console.error(chalk.red('Fatal Error during Semgrep analysis:'), err);
  process.exit(1);
});
