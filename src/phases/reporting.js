import { fs, path } from 'zx';
import chalk from 'chalk';
import { PentestError } from '../error-handling.js';

// Pure function: Assemble final report from specialist deliverables
/**
 * [목적] 레거시 보고서 흐름을 위해 deliverables를 결합 보고서로 구성.
 *
 * [호출자]
 * - 과거 report 단계 전처리에서 사용(현재는 미사용)
 * - 컨텍스트: 요약 생성 전 합본 작성
 *
 * [출력 대상]
 * - deliverables/comprehensive_security_assessment_report_raw.md 생성
 * - 최종 보고서 문자열 반환
 *
 * [입력 파라미터]
 * - sourceDir (string): deliverables가 있는 대상 레포 루트
 *
 * [반환값]
 * - Promise<string>
 *
 * [부작용]
 * - deliverables 읽기/쓰기 파일 I/O
 *
 * [의존성]
 * - zx fs/path, PentestError, chalk
 *
 * [흐름]
 * - reportStructure 순회
 * - 파일 존재 시 읽기/포맷
 * - 섹션 합치고 보고서 저장
 *
 * [에러 처리]
 * - 파일 읽기 실패는 로그 후 스킵
 * - 저장 실패는 PentestError 발생
 *
 * [주의사항]
 * - 현재는 호환성 유지 목적
 */
export async function assembleFinalReport(sourceDir) {
  console.log(chalk.blue('\n📝 Assembling comprehensive security assessment report...'));

  // Ordered categories for the report
  const reportStructure = [
    {
      name: 'Reconnaissance & Attack Surface',
      files: [
        { name: 'Pre-Reconnaissance', path: 'pre_recon_deliverable.md' },
        { name: 'Reconnaissance', path: 'recon_deliverable.md' },
        { name: 'Full Code Analysis', path: 'code_analysis_deliverable.md' }
      ]
    },
    {
      name: 'Broken Access Control & Authentication',
      files: [
        { name: 'Authentication Analysis', path: 'auth_analysis_deliverable.md' },
        { name: 'Authentication Evidence', path: 'auth_exploitation_evidence.json', isJson: true },
        { name: 'Authorization Analysis', path: 'authz_analysis_deliverable.md' },
        { name: 'Authorization Evidence', path: 'authz_exploitation_evidence.json', isJson: true }
      ]
    },
    {
      name: 'Injection Vulnerabilities',
      files: [
        { name: 'SQL Injection Analysis', path: 'sqli_analysis_deliverable.md' },
        { name: 'SQL Injection Evidence', path: 'sqli_exploitation_evidence.json', isJson: true },
        { name: 'Code Injection Analysis', path: 'codei_analysis_deliverable.md' },
        { name: 'Code Injection Evidence', path: 'codei_exploitation_evidence.json', isJson: true },
        { name: 'SSTI Analysis', path: 'ssti_analysis_deliverable.md' },
        { name: 'SSTI Evidence', path: 'ssti_exploitation_evidence.json', isJson: true },
        { name: 'Path Injection Analysis', path: 'pathi_analysis_deliverable.md' },
        { name: 'Path Injection Evidence', path: 'pathi_exploitation_evidence.json', isJson: true }
      ]
    },
    {
      name: 'Cross-Site Scripting (XSS)',
      files: [
        { name: 'XSS Analysis', path: 'xss_analysis_deliverable.md' },
        { name: 'XSS Evidence', path: 'xss_exploitation_evidence.json', isJson: true }
      ]
    },
    {
      name: 'Server-Side Request Forgery (SSRF)',
      files: [
        { name: 'SSRF Analysis', path: 'ssrf_analysis_deliverable.md' },
        { name: 'SSRF Evidence', path: 'ssrf_exploitation_evidence.json', isJson: true }
      ]
    }
  ];

  const sections = [];

  for (const category of reportStructure) {
    sections.push(`\n\n# PHASE: ${category.name}`);

    for (const file of category.files) {
      const filePath = path.join(sourceDir, 'deliverables', file.path);
      try {
        if (await fs.pathExists(filePath)) {
          let content = await fs.readFile(filePath, 'utf8');

          if (file.isJson) {
            // Format JSON as a nice code block
            content = `\n### ${file.name}\n\`\`\`json\n${content}\n\`\`\``;
          } else {
            content = `\n\n## SECTION: ${file.name}\n\n${content}`;
          }

          sections.push(content);
          console.log(chalk.green(`✅ Added ${file.name} to final report`));
        } else {
          console.log(chalk.gray(`⏭️  No ${file.name} findings found (${file.path} missing)`));
        }
      } catch (error) {
        console.log(chalk.yellow(`⚠️ Could not read ${file.path}: ${error.message}`));
      }
    }
  }

  const finalContent = sections.join('\n\n');
  const finalReportPath = path.join(sourceDir, 'deliverables', 'comprehensive_security_assessment_report_raw.md');

  try {
    await fs.writeFile(finalReportPath, finalContent);
    console.log(chalk.green(`✅ Raw report assembled at ${finalReportPath}`));
    console.log(chalk.cyan(`\n💡 To generate Korean translation, run: npm run translate-report`));
  } catch (error) {
    throw new PentestError(
      `Failed to write final report: ${error.message}`,
      'filesystem',
      false,
      { finalReportPath, originalError: error.message }
    );
  }

  return finalContent;
}

/**
 * [목적] 보고서 에이전트용 입력 파일을 안전하게 축약 생성.
 *
 * [호출자]
 * - src/checkpoint-manager.js (report 전처리)
 *
 * [출력 대상]
 * - deliverables/_report_inputs/에 파일 생성
 *
 * [입력 파라미터]
 * - sourceDir (string)
 *
 * [반환값]
 * - Promise<void>
 *
 * [부작용]
 * - deliverables 읽기 및 축약본 쓰기
 *
 * [의존성]
 * - zx fs/path, chalk
 *
 * [흐름]
 * - _report_inputs 디렉터리 생성
 * - 각 파일을 maxChars 기준으로 절단 저장
 *
 * [에러 처리]
 * - 파일별 오류는 로그 후 스킵
 *
 * [주의사항]
 * - 분석/정찰/증거/큐 요약에 사용
 */
export async function prepareReportInputs(sourceDir) {
  const inputDir = path.join(sourceDir, 'deliverables', '_report_inputs');
  await fs.ensureDir(inputDir);

  const inputs = [
    { path: 'codei_analysis_deliverable.md', maxChars: 16000 },
    { path: 'sqli_analysis_deliverable.md', maxChars: 16000 },
    { path: 'ssti_analysis_deliverable.md', maxChars: 16000 },
    { path: 'pathi_analysis_deliverable.md', maxChars: 16000 },
    { path: 'xss_analysis_deliverable.md', maxChars: 20000 },
    { path: 'auth_analysis_deliverable.md', maxChars: 16000 },
    { path: 'ssrf_analysis_deliverable.md', maxChars: 16000 },
    { path: 'authz_analysis_deliverable.md', maxChars: 16000 },
    { path: 'pre_recon_deliverable.md', maxChars: 12000 },
    { path: 'recon_deliverable.md', maxChars: 12000 },
    { path: 'auth_exploitation_evidence.json', maxChars: 12000 },
    { path: 'authz_exploitation_evidence.json', maxChars: 12000 },
    { path: 'sqli_exploitation_evidence.json', maxChars: 12000 },
    { path: 'codei_exploitation_evidence.json', maxChars: 12000 },
    { path: 'ssti_exploitation_evidence.json', maxChars: 12000 },
    { path: 'pathi_exploitation_evidence.json', maxChars: 12000 },
    { path: 'xss_exploitation_evidence.json', maxChars: 12000 },
    { path: 'ssrf_exploitation_evidence.json', maxChars: 12000 },
    { path: 'auth_exploitation_queue.json', maxChars: 12000 },
    { path: 'authz_exploitation_queue.json', maxChars: 12000 },
    { path: 'sqli_exploitation_queue.json', maxChars: 12000 },
    { path: 'codei_exploitation_queue.json', maxChars: 12000 },
    { path: 'ssti_exploitation_queue.json', maxChars: 12000 },
    { path: 'pathi_exploitation_queue.json', maxChars: 12000 },
    { path: 'xss_exploitation_queue.json', maxChars: 12000 },
    { path: 'ssrf_exploitation_queue.json', maxChars: 12000 }
  ];

  for (const input of inputs) {
    const sourcePath = path.join(sourceDir, 'deliverables', input.path);
    const targetPath = path.join(inputDir, input.path);
    try {
      if (!await fs.pathExists(sourcePath)) {
        continue;
      }
      let content = await fs.readFile(sourcePath, 'utf8');
      if (content.length > input.maxChars) {
        const truncated = content.slice(0, input.maxChars);
        content = `${truncated}\n\n[TRUNCATED - original length ${content.length} chars]`;
      }
      await fs.writeFile(targetPath, content);
    } catch (error) {
      console.log(chalk.yellow(`⚠️ Could not prepare report input ${input.path}: ${error.message}`));
    }
  }
}

/**
 * [목적] 기존 보고서 앞에 요약을 선두에 삽입.
 *
 * [호출자]
 * - 과거 report 후처리에서 사용(현재는 미사용)
 *
 * [출력 대상]
 * - reportPath 파일을 요약 포함으로 갱신
 *
 * [입력 파라미터]
 * - reportPath (string)
 * - summaryText (string)
 *
 * [반환값]
 * - Promise<boolean>
 *
 * [부작용]
 * - reportPath 읽기/쓰기
 *
 * [의존성]
 * - zx fs
 *
 * [흐름]
 * - 입력/파일 존재 확인
 * - 요약 정리 후 중복 방지
 * - 선두 삽입
 *
 * [에러 처리]
 * - 조건 불충족 시 false, I/O 실패 시 예외
 *
 * [주의사항]
 * - 레거시 호환용 함수
 */
export async function prependExecutiveSummary(reportPath, summaryText) {
  if (!summaryText || typeof summaryText !== 'string') {
    return false;
  }

  if (summaryText.length <= 100) {
    return false;
  }

  if (!await fs.pathExists(reportPath)) {
    return false;
  }

  const existingContent = await fs.readFile(reportPath, 'utf8');
  const cleanedSummary = summaryText.replace(/\[END OF YOUR OUTPUT\].*/s, '').trim();
  if (existingContent.trimStart().startsWith(cleanedSummary)) {
    return false;
  }
  await fs.writeFile(reportPath, cleanedSummary + '\n\n---\n\n' + existingContent);

  return true;
}
