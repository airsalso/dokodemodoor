import chalk from 'chalk';
import { formatDuration } from '../audit/utils.js';

// Timing utilities

/**
 * [목적] 간단한 타이머 유틸리티.
 *
 * [호출자]
 * - dokodemodoor.mjs, agent-executor
 */
export class Timer {
  constructor(name) {
    this.name = name;
    this.startTime = Date.now();
    this.endTime = null;
  }

  stop() {
    this.endTime = Date.now();
    return this.duration();
  }

  duration() {
    const end = this.endTime || Date.now();
    return end - this.startTime;
  }
}

// Global timing and cost tracker
export const timingResults = {
  total: null,
  phases: {},
  commands: {},
  agents: {}
};

export const costResults = {
  agents: {},
  total: 0
};

export const usageResults = {
  agents: {},
  prompt: 0,
  completion: 0,
  total: 0
};


// Function to display comprehensive timing summary
/**
 * [목적] 실행 시간/비용 요약 출력.
 *
 * [호출자]
 * - 메인 실행 종료 시
 */
export const displayTimingSummary = () => {
  // Use already-stopped duration if available, otherwise stop now
  const totalDuration = timingResults.total.endTime
    ? timingResults.total.duration()
    : timingResults.total.stop();

  console.log(chalk.cyan.bold('\n⏱️  TIMING SUMMARY'));
  console.log(chalk.gray('─'.repeat(60)));

  // Total execution time
  console.log(chalk.cyan(`📊 Total Execution Time: ${formatDuration(totalDuration)}`));
  console.log();

  // Phase breakdown
  if (Object.keys(timingResults.phases).length > 0) {
    console.log(chalk.yellow.bold('🔍 Phase Breakdown:'));
    let phaseTotal = 0;
    for (const [phase, duration] of Object.entries(timingResults.phases)) {
      const percentage = ((duration / totalDuration) * 100).toFixed(1);
      console.log(chalk.yellow(`  ${phase.padEnd(20)} ${formatDuration(duration).padStart(8)} (${percentage}%)`));
      phaseTotal += duration;
    }
    console.log(chalk.gray(`  ${'Phases Total'.padEnd(20)} ${formatDuration(phaseTotal).padStart(8)} (${((phaseTotal / totalDuration) * 100).toFixed(1)}%)`));
    console.log();
  }

  // Command breakdown
  if (Object.keys(timingResults.commands).length > 0) {
    console.log(chalk.blue.bold('🖥️  Command Breakdown:'));
    let commandTotal = 0;
    for (const [command, duration] of Object.entries(timingResults.commands)) {
      const percentage = ((duration / totalDuration) * 100).toFixed(1);
      console.log(chalk.blue(`  ${command.padEnd(20)} ${formatDuration(duration).padStart(8)} (${percentage}%)`));
      commandTotal += duration;
    }
    console.log(chalk.gray(`  ${'Commands Total'.padEnd(20)} ${formatDuration(commandTotal).padStart(8)} (${((commandTotal / totalDuration) * 100).toFixed(1)}%)`));
    console.log();
  }

  // Agent breakdown
  if (Object.keys(timingResults.agents).length > 0) {
    console.log(chalk.magenta.bold('🤖 Agent Breakdown:'));
    let agentTotal = 0;
    for (const [agent, duration] of Object.entries(timingResults.agents)) {
      const percentage = ((duration / totalDuration) * 100).toFixed(1);
      const displayName = agent.replace(/-/g, ' ');
      console.log(chalk.magenta(`  ${displayName.padEnd(20)} ${formatDuration(duration).padStart(8)} (${percentage}%)`));
      agentTotal += duration;
    }
    console.log(chalk.gray(`  ${'Agents Total'.padEnd(20)} ${formatDuration(agentTotal).padStart(8)} (${((agentTotal / totalDuration) * 100).toFixed(1)}%)`));
  }

  // Cost breakdown
  if (Object.keys(costResults.agents).length > 0) {
    console.log(chalk.green.bold('\n💰 Cost Breakdown:'));
    for (const [agent, cost] of Object.entries(costResults.agents)) {
      const displayName = agent.replace(/-/g, ' ');
      console.log(chalk.green(`  ${displayName.padEnd(20)} $${cost.toFixed(4).padStart(8)}`));
    }
    console.log(chalk.gray(`  ${'Total Cost'.padEnd(20)} $${costResults.total.toFixed(4).padStart(8)}`));
  }

  // Usage breakdown
  if (usageResults.total > 0) {
    console.log(chalk.blue.bold('\n📊 Token Usage:'));

    // Per-agent usage if available
    if (Object.keys(usageResults.agents).length > 0) {
      for (const [agent, usage] of Object.entries(usageResults.agents)) {
        const displayName = agent.replace(/-/g, ' ');
        console.log(chalk.blue(`  ${displayName.padEnd(20)} ${usage.total.toLocaleString().padStart(12)} tokens`));
      }
      console.log(chalk.gray('  ' + '─'.repeat(40)));
    }

    console.log(chalk.blue(`  Prompt Context:      ${usageResults.prompt.toLocaleString().padStart(12)} tokens`));
    console.log(chalk.blue(`  Model Completion:    ${usageResults.completion.toLocaleString().padStart(12)} tokens`));
    console.log(chalk.blue(`  Total Consumption:   ${usageResults.total.toLocaleString().padStart(12)} tokens`));
  }

  console.log(chalk.gray('─'.repeat(60)));
};
