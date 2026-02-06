import { $, fs, path } from 'zx';
import chalk from 'chalk';
import { Timer, timingResults } from '../utils/metrics.js';
import { formatDuration } from '../audit/utils.js';
import { handleToolError, PentestError } from '../error-handling.js';
import { AGENTS } from '../session-manager.js';
import { runAgentPromptWithRetry } from '../ai/agent-executor.js';
import { loadPrompt } from '../prompts/prompt-manager.js';
import { getLocalISOString } from '../utils/time-utils.js';

const buildSkippedResult = (tool, reason) => ({
  tool,
  output: `Skipped: ${reason}`,
  status: 'skipped',
  duration: 0
});

const normalizeMockResult = (tool, output) => ({
  tool,
  output,
  status: 'skipped',
  duration: 0
});

// Pure function: Run terminal scanning tools
/**
 * [목적] nmap/subfinder/whatweb/schemathesis 등 터미널 스캔 실행.
 *
 * [호출자]
 * - runPreReconWave1()
 *
 * [입력 파라미터]
 * - tool (string)
 * - target (string)
 * - sourceDir (string|null)
 *
 * [반환값]
 * - Promise<object>
 */
async function runTerminalScan(tool, target, sourceDir = null) {
  const timer = new Timer(`command-${tool}`);
  try {
    let command, result;
    switch (tool) {
      case 'nmap':
        console.log(chalk.blue(`    🔍 Running ${tool} scan...`));
        // Use -Pn to skip host discovery (ping) - essential for local networks and Docker
        const nmapUrl = new URL(target);
        const nmapHostname = nmapUrl.hostname;
        if (nmapUrl.port) {
          result = await $({ silent: true })`nmap -Pn -sV -sC -p ${nmapUrl.port} ${nmapHostname}`.catch(e => e);
        } else {
          result = await $({ silent: true })`nmap -Pn -sV -sC ${nmapHostname}`.catch(e => e);
        }
        const duration = timer.stop();
        timingResults.commands[tool] = duration;
        console.log(chalk.green(`    ✅ ${tool} completed in ${formatDuration(duration)}`));
        const nmapOutput = (result.stdout || '') + (result.stderr || '');
        return { tool: 'nmap', output: nmapOutput.trim(), status: result.exitCode === 0 ? 'success' : 'error', duration };
      case 'subfinder':
        console.log(chalk.blue(`    🔍 Running ${tool} scan...`));
        const hostname = new URL(target).hostname;

        // Skip subfinder for IP addresses (it only works with domains)
        if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
          console.log(chalk.yellow(`    ⚠️  Skipping subfinder for IP address: ${hostname}`));
          return { tool: 'subfinder', output: 'Skipped: subfinder only works with domain names, not IP addresses', status: 'skipped', duration: 0 };
        }

        result = await $({ silent: true })`subfinder -d ${hostname}`.catch(e => e);
        const subfinderDuration = timer.stop();
        timingResults.commands[tool] = subfinderDuration;
        console.log(chalk.green(`    ✅ ${tool} completed in ${formatDuration(subfinderDuration)}`));

        // Return meaningful output or indicate no subdomains found
        const subfinderOutput = ((result.stdout || '') + (result.stderr || '')).trim() || 'No subdomains discovered';
        return { tool: 'subfinder', output: subfinderOutput, status: result.exitCode === 0 ? 'success' : 'error', duration: subfinderDuration };
      case 'whatweb':
        console.log(chalk.blue(`    🔍 Running ${tool} scan...`));
        // Use --color=never to remove ANSI escape codes from output
        command = `whatweb --color=never --open-timeout 30 --read-timeout 60 ${target}`;
        console.log(chalk.gray(`    Command: ${command}`));
        result = await $({ silent: true })`whatweb --color=never --open-timeout 30 --read-timeout 60 ${target}`.catch(e => e);
        const whatwebDuration = timer.stop();
        timingResults.commands[tool] = whatwebDuration;
        console.log(chalk.green(`    ✅ ${tool} completed in ${formatDuration(whatwebDuration)}`));
        const whatwebOutput = ((result.stdout || '') + (result.stderr || '')).trim();
        const whatwebStatus = (result.exitCode === 0 && !whatwebOutput.includes('unrecognized option')) ? 'success' : 'error';
        return { tool: 'whatweb', output: whatwebOutput || 'No technology information found', status: whatwebStatus, duration: whatwebDuration };
      case 'schemathesis':
        let schemathesisResults = [];
        const schemasDir = path.join(sourceDir || '.', 'outputs', 'schemas');
        let schemasFound = false;

        // 1. Try local file-based schemas first
        if (await fs.pathExists(schemasDir)) {
          const schemaFiles = await fs.readdir(schemasDir);
          const potentialSchemas = schemaFiles.filter(f =>
            f.endsWith('.json') || f.endsWith('.yml') || f.endsWith('.yaml')
          );

          for (const file of potentialSchemas) {
            const filePath = path.join(schemasDir, file);
            try {
              const content = await fs.readFile(filePath, 'utf8');
              if (content.includes('openapi') || content.includes('swagger') || content.includes('"paths"') || content.includes('paths:')) {
                console.log(chalk.blue(`    🔍 Running ${tool} on local schema: ${file}...`));
                result = await $({ silent: true, stdio: ['ignore', 'pipe', 'ignore'] })`schemathesis run ${filePath} -u ${target} --checks all --max-failures=10 --exitfirst`;
                schemathesisResults.push(`Local Schema: ${file}\n${result.stdout}`);
                schemasFound = true;
              }
            } catch (e) {
              console.log(chalk.yellow(`    ⚠️  Schemathesis failed on ${file}: ${e.message}`));
            }
          }
        }

        // 2. If no local schemas found, probe common API documentation URLs
        if (!schemasFound) {
          const commonPaths = [
            '/api-docs/', '/api-docs', '/swagger.json', '/openapi.json',
            '/v2/api-docs', '/swagger/v1/swagger.json', '/rest/api-docs'
          ];
          const baseUrl = target.endsWith('/') ? target.slice(0, -1) : target;

          console.log(chalk.blue(`    🔍 No local schemas found. Probing common API paths...`));

          for (const p of commonPaths) {
            const schemaUrl = `${baseUrl}${p}`;
            try {
              console.log(chalk.gray(`    → Probing ${schemaUrl}`));
              // Use schemathesis run directly on the URL
              // Increased timeout to 20s as schemathesis can be slow to init
              result = await $({ silent: true, stdio: ['ignore', 'pipe', 'ignore'] })`schemathesis run ${schemaUrl} --checks all --max-failures=5 --exitfirst`.timeout(20000);

              if (result.exitCode === 0 || (result.stdout && result.stdout.includes('Checks'))) {
                console.log(chalk.green(`    ✅ Found and tested API via ${p}`));
                schemathesisResults.push(`Remote Schema: ${schemaUrl}\n${result.stdout}`);
                schemasFound = true;
                break; // Stop after first successful discovery
              }
            } catch (e) {
              if (e.stdout && e.stdout.includes('Schema Error')) {
                console.log(chalk.yellow(`    ⚠️  Found schema at ${p} but it is invalid.`));
              }
              // Ignore other errors (404, etc.)
            }
          }
        }

        const schemathesisDuration = timer.stop();
        timingResults.commands[tool] = schemathesisDuration;

        if (schemasFound) {
          console.log(chalk.green(`    ✅ ${tool} completed in ${formatDuration(schemathesisDuration)}`));
          return { tool: 'schemathesis', output: schemathesisResults.join('\n\n'), status: 'success', duration: schemathesisDuration };
        } else {
          console.log(chalk.gray(`    ⏭️ ${tool} - no valid API schemas discovered`));
          return { tool: 'schemathesis', output: 'No valid OpenAPI schemas found locally or via probing', status: 'skipped', duration: schemathesisDuration };
        }
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  } catch (error) {
    const duration = timer.stop();
    timingResults.commands[tool] = duration;
    console.log(chalk.red(`    ❌ ${tool} failed in ${formatDuration(duration)}`));
    return handleToolError(tool, error);
  }
}

// Wave 1: Initial footprinting + authentication
/**
 * [목적] Pre-Recon 1차 웨이브 실행 (스캔/코드분석).
 *
 * [호출자]
 * - executePreReconPhase()
 */
async function runPreReconWave1(webUrl, sourceDir, variables, config, toolAvailability, sessionId = null) {
  // Check if using vLLM provider to decide on sequential execution
  const { isVLLMProvider, config: envConfig } = await import('../config/env.js').catch(() => ({ isVLLMProvider: () => false, config: null }));
  const useSequential = isVLLMProvider() && !envConfig?.dokodemodoor?.preReconParallel;

  const skipNmap = envConfig?.dokodemodoor?.skipNmap || false;
  const skipSubfinder = envConfig?.dokodemodoor?.skipSubfinder || false;
  const skipWhatweb = envConfig?.dokodemodoor?.skipWhatweb || false;
  const skipSchemathesis = envConfig?.dokodemodoor?.skipSchemathesis || false;

  if (skipSchemathesis) {
    console.log(chalk.gray('    ⏭️  Skipping schemathesis (DOKODEMODOOR_SKIP_SCHEMATHESIS=true)'));
  } else {
    console.log(chalk.blue('    🛡️  Schemathesis scanning enabled (API fuzzing)'));
  }

  if (useSequential) {
    console.log(chalk.blue('    → Running Wave 1 operations sequentially for best performance on local LLM...'));

    let nmap, subfinder, whatweb, codeAnalysis;

    // Nmap
    if (skipNmap) {
      console.log(chalk.gray('    ⏭️  Skipping nmap (DOKODEMODOOR_SKIP_NMAP=true)'));
      nmap = normalizeMockResult('nmap', 'nmap-mock');
    } else {
      nmap = toolAvailability?.nmap
        ? await runTerminalScan('nmap', webUrl)
        : buildSkippedResult('nmap', 'tool not available');
    }

    // Subfinder
    if (skipSubfinder) {
      console.log(chalk.gray('    ⏭️  Skipping subfinder (DOKODEMODOOR_SKIP_SUBFINDER=true)'));
      subfinder = normalizeMockResult('subfinder', 'subfinder-mock');
    } else {
      subfinder = toolAvailability?.subfinder
        ? await runTerminalScan('subfinder', webUrl)
        : buildSkippedResult('subfinder', 'tool not available');
    }

    // Whatweb
    if (skipWhatweb) {
      console.log(chalk.gray('    ⏭️  Skipping whatweb (DOKODEMODOOR_SKIP_WHATWEB=true)'));
      whatweb = normalizeMockResult('whatweb', 'whatweb-mock');
    } else {
      whatweb = toolAvailability?.whatweb
        ? await runTerminalScan('whatweb', webUrl)
        : buildSkippedResult('whatweb', 'tool not available');
    }

    // Code Analysis
    const agentVariables = {
      ...variables,
      SCHEMATHESIS_BANNER: skipSchemathesis ? '(DEPRECATED/SKIP)' : '(ENCOURAGED: High priority for API fuzzing)'
    };

    codeAnalysis = await runAgentPromptWithRetry(
      await loadPrompt('pre-recon-code', agentVariables, null),
      sourceDir,
      '*',
      '',
      AGENTS['pre-recon'].displayName,
      'pre-recon',
      chalk.cyan,
      { id: sessionId, webUrl }
    );

    return { nmap, subfinder, whatweb, codeAnalysis };
  }

  // Wave 1: Initial footprinting (Parallel)
  console.log(chalk.gray(`    → Launching Wave 1 operations in parallel...`));
  const operations = [];

  // Nmap
  if (skipNmap) {
    console.log(chalk.gray('    ⏭️  Skipping nmap (DOKODEMODOOR_SKIP_NMAP=true)'));
    operations.push(Promise.resolve(normalizeMockResult('nmap', 'nmap-mock')));
  } else {
    operations.push(
      toolAvailability?.nmap
        ? runTerminalScan('nmap', webUrl)
        : Promise.resolve(buildSkippedResult('nmap', 'tool not available'))
    );
  }

  // Subfinder
  if (skipSubfinder) {
    console.log(chalk.gray('    ⏭️  Skipping subfinder (DOKODEMODOOR_SKIP_SUBFINDER=true)'));
    operations.push(Promise.resolve(normalizeMockResult('subfinder', 'subfinder-mock')));
  } else {
    operations.push(
      toolAvailability?.subfinder
        ? runTerminalScan('subfinder', webUrl)
        : Promise.resolve(buildSkippedResult('subfinder', 'tool not available'))
    );
  }

  // Whatweb
  if (skipWhatweb) {
    console.log(chalk.gray('    ⏭️  Skipping whatweb (DOKODEMODOOR_SKIP_WHATWEB=true)'));
    operations.push(Promise.resolve(normalizeMockResult('whatweb', 'whatweb-mock')));
  } else {
    operations.push(
      toolAvailability?.whatweb
        ? runTerminalScan('whatweb', webUrl)
        : Promise.resolve(buildSkippedResult('whatweb', 'tool not available'))
    );
  }

  // Code Analysis
  const agentVariables = {
    ...variables,
    SCHEMATHESIS_BANNER: skipSchemathesis ? '(DEPRECATED/SKIP)' : '(ENCOURAGED: High priority for API fuzzing)'
  };

  operations.push(
    runAgentPromptWithRetry(
      await loadPrompt('pre-recon-code', agentVariables, null),
      sourceDir,
      '*',
      '',
      AGENTS['pre-recon'].displayName,
      'pre-recon',
      chalk.cyan,
      { id: sessionId, webUrl }
    )
  );

  const [nmap, subfinder, whatweb, codeAnalysis] = await Promise.all(operations);

  return { nmap, subfinder, whatweb, codeAnalysis };
}

// Wave 2: Additional scanning
/**
 * [목적] Pre-Recon 2차 웨이브 실행 (추가 스캔).
 *
 * [호출자]
 * - executePreReconPhase()
 */
async function runPreReconWave2(webUrl, sourceDir, toolAvailability) {
  console.log(chalk.blue('    → Running Wave 2 additional scans in parallel...'));

  const { config: envConfig } = await import('../config/env.js').catch(() => ({ config: null }));
  const skipSchemathesis = envConfig?.dokodemodoor?.skipSchemathesis ?? true;

  const operations = [];

  // Parallel additional scans (only run if tools are available)
  if (skipSchemathesis) {
    console.log(chalk.gray('    ⏭️ Skipping schemathesis (DOKODEMODOOR_SKIP_SCHEMATHESIS=true)'));
  } else if (toolAvailability.schemathesis) {
    operations.push(runTerminalScan('schemathesis', webUrl, sourceDir));
  }

  // If no tools are available or skipping, return early
  if (operations.length === 0) {
    console.log(chalk.gray('    ⏭️ No active Wave 2 operations'));
    return {
      schemathesis: skipSchemathesis
        ? { tool: 'schemathesis', output: 'Skipped (DOKODEMODOOR_SKIP_SCHEMATHESIS=true)', status: 'skipped', duration: 0 }
        : { tool: 'schemathesis', output: 'Tool not available', status: 'skipped', duration: 0 }
    };
  }

  // Run all operations in parallel
  const results = await Promise.all(operations);

  // Map results back to named properties
  const response = {};
  let resultIndex = 0;

  if (!skipSchemathesis && toolAvailability.schemathesis) {
    response.schemathesis = results[resultIndex++];
  } else {
    response.schemathesis = skipSchemathesis
      ? { tool: 'schemathesis', output: 'Skipped (DOKODEMODOOR_SKIP_SCHEMATHESIS=true)', status: 'skipped', duration: 0 }
      : { tool: 'schemathesis', output: 'Tool not available', status: 'skipped', duration: 0 };
  }

  return response;
}

// Helper function to format nmap output as markdown
function formatNmapOutput(nmapResult) {
  if (!nmapResult || !nmapResult.output) return 'No output';

  const output = nmapResult.output;
  let md = '';

  // Add scan header
  const scanStart = output.match(/Starting Nmap[^\n]+/);
  if (scanStart) md += '```\n' + scanStart[0] + '\n```\n\n';

  // Extract and format ports
  const portLines = output.match(/^\d+\/tcp.+$/gm);
  if (portLines && portLines.length > 0) {
    md += '### Open Ports\n\n';
    md += '| Port | State | Service | Version |\n';
    md += '|------|-------|---------|----------|\n';

    portLines.forEach(line => {
      const parts = line.split(/\s+/);
      const port = parts[0];
      const state = parts[1];
      const service = parts[2];
      const version = parts.slice(3).join(' ').substring(0, 80);
      md += `| ${port} | ${state} | ${service} | ${version} |\n`;
    });
    md += '\n';
  }

  // Add summary
  const done = output.match(/Nmap done:[^\n]+/);
  if (done) md += '**Summary**: ' + done[0] + '\n';

  return md || output;
}

const dedupeEndpointLists = (content) => {
  if (!content || typeof content !== 'string') {
    return content;
  }

  const lines = content.split('\n');
  const updated = lines.map(line => {
    if (!line.includes('/')) {
      return line;
    }

    const codeMatches = [...line.matchAll(/`\/[^`]+`/g)];
    const rawMatches = [...line.matchAll(/\/[A-Za-z0-9/_-]+/g)];
    const matches = codeMatches.length > 0 ? codeMatches : rawMatches;

    if (matches.length < 8) {
      return line;
    }

    const unique = [];
    const seen = new Set();
    for (const match of matches) {
      const token = match[0];
      const normalized = token.replace(/`/g, '');
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      unique.push(token);
    }

    if (unique.length === matches.length) {
      return line;
    }

    if (!line.includes('e.g') && line.length < 300) {
      return line;
    }

    const first = matches[0];
    const last = matches[matches.length - 1];
    const start = first.index ?? 0;
    const end = (last.index ?? 0) + last[0].length;
    const replacement = unique.join(', ');

    return line.slice(0, start) + replacement + line.slice(end);
  });

  return updated.join('\n');
};

// Pure function: Stitch together pre-recon outputs and save to file
async function stitchPreReconOutputs(outputs, sourceDir) {
  const [nmap, subfinder, whatweb, codeAnalysis, ...additionalScans] = outputs;

  // Try to read the code analysis deliverable file
  let codeAnalysisContent = 'No analysis available';
  try {
    const codeAnalysisPath = path.join(sourceDir, 'deliverables', 'code_analysis_deliverable.md');
    codeAnalysisContent = await fs.readFile(codeAnalysisPath, 'utf8');
    codeAnalysisContent = dedupeEndpointLists(codeAnalysisContent);
  } catch (error) {
    console.log(chalk.yellow(`⚠️ Could not read code analysis deliverable: ${error.message}`));
    // Fallback message if file doesn't exist
    codeAnalysisContent = 'Analysis located in deliverables/code_analysis_deliverable.md';
  }


  // Build additional scans section
  let additionalSection = '';
  if (additionalScans && additionalScans.length > 0) {
    additionalSection = '\n## Authenticated Scans\n';
    additionalScans.forEach(scan => {
      if (scan && scan.tool) {
        additionalSection += `
### ${scan.tool.toUpperCase()}
Status: ${scan.status}
${scan.output}
`;
      }
    });
  }

  const report = `
# Pre-Reconnaissance Report


## Network Scanning (nmap)
Status: ${nmap?.status || 'Skipped'}
${formatNmapOutput(nmap)}

## Subdomain Discovery (subfinder)
Status: ${subfinder?.status || 'Skipped'}
${(() => {
  if (!subfinder) return 'No output discovered';
  const out = typeof subfinder === 'string' ? subfinder : (subfinder.output || '');
  return out.trim() || 'No results found';
})()}

## Technology Detection (whatweb)
Status: ${whatweb?.status || 'Skipped'}
${(() => {
  if (!whatweb) return 'No output found';
  const out = typeof whatweb === 'string' ? whatweb : (whatweb.output || '');
  return out.trim() ? "```\n" + out.trim() + "\n```" : 'No technology information discovered';
})()}
## Code Analysis
${codeAnalysisContent}
${additionalSection}
---
Report generated at: ${getLocalISOString()}
  `.trim();

  // Ensure deliverables directory exists in the cloned repo
  try {
    const deliverablePath = path.join(sourceDir, 'deliverables', 'pre_recon_deliverable.md');
    await fs.ensureDir(path.join(sourceDir, 'deliverables'));

    // Write to file in the cloned repository
    await fs.writeFile(deliverablePath, report);
  } catch (error) {
    throw new PentestError(
      `Failed to write pre-recon report: ${error.message}`,
      'filesystem',
      false,
      { sourceDir, originalError: error.message }
    );
  }

  return report;
}

// Main pre-recon phase execution function
/**
 * [목적] Pre-Recon 단계 전체 오케스트레이션.
 *
 * [호출자]
 * - dokodemodoor.mjs
 */
export async function executePreReconPhase(webUrl, sourceDir, variables, config, toolAvailability, sessionId = null) {
  console.log(chalk.yellow.bold('\n🔍 PHASE 1: PRE-RECONNAISSANCE'));
  const timer = new Timer('phase-1-pre-recon');

  console.log(chalk.yellow('Wave 1: Initial footprinting...'));
  const wave1Results = await runPreReconWave1(webUrl, sourceDir, variables, config, toolAvailability, sessionId);
  console.log(chalk.green('  ✅ Wave 1 operations completed'));

  console.log(chalk.yellow('Wave 2: Additional scanning...'));
  const wave2Results = await runPreReconWave2(webUrl, sourceDir, toolAvailability);
  console.log(chalk.green('  ✅ Wave 2 operations completed'));

  console.log(chalk.blue('📝 Stitching pre-recon outputs...'));
  // Combine wave 1 and wave 2 results for stitching
  const allResults = [
    wave1Results.nmap,
    wave1Results.subfinder,
    wave1Results.whatweb,

    wave1Results.codeAnalysis,
    ...(wave2Results.schemathesis ? [wave2Results.schemathesis] : [])
  ];
  const preReconReport = await stitchPreReconOutputs(allResults, sourceDir);
  const duration = timer.stop();

  console.log(chalk.green(`✅ Pre-reconnaissance complete in ${formatDuration(duration)}`));
  console.log(chalk.green(`💾 Saved to ${sourceDir}/deliverables/pre_recon_deliverable.md`));

  return { duration, report: preReconReport };
}
