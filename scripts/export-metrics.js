/**
* 메트릭을 CSV 파일로 내보내기
*
* 감사 로그의 session.json 파일을 스프레드시트 분석을 위한 CSV 형식으로 변환합니다.
* *
* 데이터 소스:
* - 읽어오는 위치: audit-logs/{hostname}_{sessionId}/session.json
* - 모든 메트릭, 타이밍 및 비용 데이터의 주요 출처
* - DokodemoDoor가 에이전트 실행 중에 자동으로 생성
*
* CSV 출력:
* - 에이전트별 한 행, 각 행에는 에이전트, 단계, 상태, 시도 횟수, duration_ms, cost_usd 정보가 포함됩니다.
* - Excel/Google Sheets로 가져와 분석하기에 적합합니다.
*
* 사용 사례:
* - 여러 세션의 성능 비교
* - 비용 추적 및 예산 최적화
* - 최적화를 위해 속도가 느린 에이전트 식별
* - 차트 및 시각화 생성
* - 외부 보고 도구용 데이터 내보내기
*
* 예시:
* ```bash
* # 표준 출력으로 내보내기
* ./scripts/export-metrics.js --session-id abc123
*
* # 파일로 내보내기
* ./scripts/export-metrics.js --session-id abc123 --output metrics.csv
* # DokodemoDoor 스토어에서 세션 ID 찾기
* cat .dokodemodoor-store.json | jq '.sessions | keys'
* ```
*
* 참고: 원시 메트릭을 보려면 audit-logs/.../session.json 파일을 직접 읽으세요.
* 이 스크립트는 스프레드시트에서 사용하기 쉬운 CSV 형식을 제공하기 위한 것입니다.
*/

import chalk from 'chalk';
import { fs, path } from 'zx';
import { getSession } from '../src/session-manager.js';
import { AuditSession } from '../src/audit/index.js';

// Parse command-line arguments
/**
 * [목적] CLI 인자 파싱.
 *
 * [호출자]
 * - main()
 */
function parseArgs() {
  const args = {
    sessionId: null,
    output: null
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];

    if (arg === '--session-id' && process.argv[i + 1]) {
      args.sessionId = process.argv[i + 1];
      i++;
    } else if (arg === '--output' && process.argv[i + 1]) {
      args.output = process.argv[i + 1];
      i++;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.log(chalk.red(`❌ Unknown argument: ${arg}`));
      printUsage();
      process.exit(1);
    }
  }

  return args;
}

/**
 * [목적] 사용법 출력.
 *
 * [호출자]
 * - parseArgs(), main()
 */
function printUsage() {
  console.log(chalk.cyan('\n📊 Export Metrics to CSV'));
  console.log(chalk.gray('\nUsage: ./scripts/export-metrics.js [options]\n'));
  console.log(chalk.white('Options:'));
  console.log(chalk.gray('  --session-id <id>      Session ID to export (required)'));
  console.log(chalk.gray('  --output <file>        Output CSV file path (default: stdout)'));
  console.log(chalk.gray('  --help, -h             Show this help\n'));
  console.log(chalk.white('Examples:'));
  console.log(chalk.gray('  # Export to stdout'));
  console.log(chalk.gray('  ./scripts/export-metrics.js --session-id abc123\n'));
  console.log(chalk.gray('  # Export to file'));
  console.log(chalk.gray('  ./scripts/export-metrics.js --session-id abc123 --output metrics.csv\n'));
}

// Export metrics for a session
/**
 * [목적] 세션 메트릭을 CSV 문자열로 변환.
 *
 * [호출자]
 * - main()
 */
async function exportMetrics(sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const auditSession = new AuditSession(session);
  await auditSession.initialize();
  const metrics = await auditSession.getMetrics();

  return exportAsCSV(session, metrics);
}

// Export as CSV
/**
 * [목적] 메트릭 데이터를 CSV 포맷으로 변환.
 *
 * [호출자]
 * - exportMetrics()
 */
function exportAsCSV(session, metrics) {
  const lines = [];

  // Header
  lines.push('agent,phase,status,attempts,duration_ms,cost_usd');

  // Phase mapping
  const phaseMap = {
    'pre-recon': 'pre-recon',
    'recon': 'recon',
    'sqli-vuln': 'vulnerability-analysis',
    'codei-vuln': 'vulnerability-analysis',
    'ssti-vuln': 'vulnerability-analysis',
    'pathi-vuln': 'vulnerability-analysis',
    'xss-vuln': 'vulnerability-analysis',
    'auth-vuln': 'vulnerability-analysis',
    'authz-vuln': 'vulnerability-analysis',
    'ssrf-vuln': 'vulnerability-analysis',
    'sqli-exploit': 'exploitation',
    'codei-exploit': 'exploitation',
    'ssti-exploit': 'exploitation',
    'pathi-exploit': 'exploitation',
    'xss-exploit': 'exploitation',
    'auth-exploit': 'exploitation',
    'authz-exploit': 'exploitation',
    'ssrf-exploit': 'exploitation',
    'report': 'reporting'
  };

  // Agent rows
  for (const [agentName, agentData] of Object.entries(metrics.metrics.agents)) {
    const phase = phaseMap[agentName] || 'unknown';

    lines.push([
      agentName,
      phase,
      agentData.status,
      agentData.attempts.length,
      agentData.final_duration_ms,
      agentData.total_cost_usd.toFixed(4)
    ].join(','));
  }

  return lines.join('\n');
}

// Main execution
/**
 * [목적] 스크립트 진입점.
 */
async function main() {
  const args = parseArgs();

  if (!args.sessionId) {
    console.log(chalk.red('❌ Must specify --session-id'));
    printUsage();
    process.exit(1);
  }

  console.log(chalk.cyan.bold('\n📊 Exporting Metrics to CSV\n'));
  console.log(chalk.gray(`Session ID: ${args.sessionId}\n`));

  const output = await exportMetrics(args.sessionId);

  if (args.output) {
    await fs.writeFile(args.output, output);
    console.log(chalk.green(`✅ Exported to: ${args.output}`));
  } else {
    console.log(chalk.cyan('CSV Output:\n'));
    console.log(output);
  }

  console.log();
}

main().catch(error => {
  console.log(chalk.red.bold(`\n🚨 Fatal error: ${error.message}`));
  if (process.env.DEBUG) {
    console.log(chalk.gray(error.stack));
  }
  process.exit(1);
});
