#!/usr/bin/env node

/**
 * Phase-Based Tool Optimization Validator
 *
 * Validates that the phase-based tool requirements are correctly configured
 * and all agents are properly mapped to phases.
 */

import { PHASE_TOOL_REQUIREMENTS, AGENT_TOOL_OVERRIDES, MCP_AGENT_MAPPING } from '../src/constants.js';
import { AGENTS } from '../src/session-manager.js';
import chalk from 'chalk';

console.log(chalk.blue('\n🔍 Phase-Based Tool Optimization Validator\n'));
console.log(chalk.gray('='.repeat(60)));

// Helper function to get agent phase
function getAgentPhase(agentName) {
  if (agentName === 'pre-recon') return 'pre-reconnaissance';
  if (agentName === 'recon' || agentName === 'recon-verify' || agentName === 'login-check') return 'reconnaissance';
  if (agentName.endsWith('-vuln')) return 'vulnerability-analysis';
  if (agentName.endsWith('-exploit')) return 'exploitation';
  if (agentName === 'report') return 'reporting';
  return null;
}

// Helper function to convert agent name to prompt name
function agentNameToPromptName(agentName) {
  if (agentName === 'pre-recon') return 'pre-recon-code';
  if (agentName === 'report') return 'report-executive';
  if (agentName === 'recon') return 'recon';

  const vulnMatch = agentName.match(/^(.+)-vuln$/);
  if (vulnMatch) return `vuln-${vulnMatch[1]}`;

  const exploitMatch = agentName.match(/^(.+)-exploit$/);
  if (exploitMatch) return `exploit-${exploitMatch[1]}`;

  return agentName;
}

// Validate all agents
console.log(chalk.cyan('\n📋 Agent Tool Requirements:\n'));

const phaseSummary = {
  'pre-reconnaissance': { agents: [], playwright: 0 },
  'reconnaissance': { agents: [], playwright: 0 },
  'vulnerability-analysis': { agents: [], playwright: 0 },
  'exploitation': { agents: [], playwright: 0 },
  'reporting': { agents: [], playwright: 0 }
};

let totalAgents = 0;
let totalPlaywright = 0;

for (const [agentKey, agentConfig] of Object.entries(AGENTS)) {
  const agentName = agentConfig.name;
  const promptName = agentNameToPromptName(agentName);
  const phase = getAgentPhase(agentName);

  totalAgents++;

  let needsPlaywright = false;
  let source = '';

  // Check for agent-specific override
  if (AGENT_TOOL_OVERRIDES[promptName]) {
    needsPlaywright = AGENT_TOOL_OVERRIDES[promptName].playwright;
    source = '🎯 Override';
  } else if (phase && PHASE_TOOL_REQUIREMENTS[phase]) {
    needsPlaywright = PHASE_TOOL_REQUIREMENTS[phase].playwright;
    source = '📦 Phase';
  } else {
    needsPlaywright = true;
    source = '⚠️  Fallback';
  }

  if (needsPlaywright) totalPlaywright++;

  // Update phase summary
  if (phase && phaseSummary[phase]) {
    phaseSummary[phase].agents.push(agentName);
    if (needsPlaywright) phaseSummary[phase].playwright++;
  }

  const playwrightIcon = needsPlaywright ? chalk.green('✅') : chalk.gray('❌');

  console.log(`  ${chalk.yellow(agentName.padEnd(20))} ${source.padEnd(12)} Playwright: ${playwrightIcon}  (${phase || 'unknown'})`);
}

// Print phase summary
console.log(chalk.cyan('\n📊 Phase Summary:\n'));

for (const [phaseName, summary] of Object.entries(phaseSummary)) {
  const agentCount = summary.agents.length;
  if (agentCount === 0) continue;

  const playwrightPct = ((summary.playwright / agentCount) * 100).toFixed(0);

  console.log(chalk.blue(`  ${phaseName}:`));
  console.log(chalk.gray(`    Agents: ${agentCount}`));
  console.log(chalk.gray(`    Playwright: ${summary.playwright}/${agentCount} (${playwrightPct}%)`));
}

// Print overall statistics
console.log(chalk.cyan('\n📈 Overall Statistics:\n'));

const playwrightSavings = ((1 - totalPlaywright / totalAgents) * 100).toFixed(0);

console.log(chalk.gray(`  Total Agents: ${totalAgents}`));
console.log(chalk.gray(`  Playwright Enabled: ${totalPlaywright}/${totalAgents} (${playwrightSavings}% reduction)`));

// Validate MCP agent mapping
console.log(chalk.cyan('\n🎭 Playwright MCP Mapping Validation:\n'));

let mappingErrors = 0;

for (const [agentKey, agentConfig] of Object.entries(AGENTS)) {
  const agentName = agentConfig.name;
  const promptName = agentNameToPromptName(agentName);
  const phase = getAgentPhase(agentName);

  // Determine if agent needs Playwright
  let needsPlaywright = false;
  if (AGENT_TOOL_OVERRIDES[promptName]) {
    needsPlaywright = AGENT_TOOL_OVERRIDES[promptName].playwright;
  } else if (phase && PHASE_TOOL_REQUIREMENTS[phase]) {
    needsPlaywright = PHASE_TOOL_REQUIREMENTS[phase].playwright;
  } else {
    needsPlaywright = true;
  }

  const hasMcpMapping = !!MCP_AGENT_MAPPING[promptName];

  if (needsPlaywright && !hasMcpMapping) {
    console.log(chalk.red(`  ❌ ${agentName} needs Playwright but has no MCP mapping`));
    mappingErrors++;
  } else if (!needsPlaywright && hasMcpMapping) {
    console.log(chalk.yellow(`  ⚠️  ${agentName} doesn't need Playwright but has MCP mapping (${MCP_AGENT_MAPPING[promptName]})`));
  } else if (needsPlaywright && hasMcpMapping) {
    console.log(chalk.green(`  ✅ ${agentName} → ${MCP_AGENT_MAPPING[promptName]}`));
  } else {
    console.log(chalk.gray(`  ⏭️  ${agentName} (no Playwright needed)`));
  }
}

// Final verdict
console.log(chalk.gray('\n' + '='.repeat(60)));

if (mappingErrors > 0) {
  console.log(chalk.red(`\n❌ Validation FAILED: ${mappingErrors} mapping error(s) found\n`));
  process.exit(1);
} else {
  console.log(chalk.green('\n✅ Validation PASSED: All agents properly configured\n'));
  process.exit(0);
}
