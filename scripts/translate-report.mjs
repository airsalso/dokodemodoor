import { fs, path } from 'zx';
import chalk from 'chalk';
import dotenv from 'dotenv';

dotenv.config();

const TRANSLATOR_PROMPT = `You are a **Senior Cybersecurity Technical Translator**. Your expertise is in translating complex penetration testing reports, vulnerability analyses, and security assessment documentation from English to Korean.

# CRITICAL RULES (MANDATORY)

1. **Maintain Markdown Structure:** DO NOT alter any Markdown syntax. All headers (#), lists (- *), tables, bold/italic text, and code blocks (\`\`\`) must remain exactly as they are in the source.
2. **Handle Technical Terms Specifically:**
   - Keep standard industry terms in English (e.g., SQL Injection, XSS, Payload, Endpoint, Middleware, Sanitization).
   - You may use a hybrid format for clarity: "Blind SQL 인젝션 (Blind SQL Injection)".
   - Do NOT translate function names or variable names found in code blocks.
3. **Tone and Manner:** Use a formal, professional, and objective tone suitable for a high-level executive security report (e.g., "-합시다" 대신 "-합니다", "-임", "-함" 등 격식체 사용).
4. **Accuracy:** Ensure that the severity of findings and the technical nuances of the vulnerability descriptions are perfectly preserved.
5. **No Hallucinations:** Do not add findings that aren't in the source. If a section is unclear, translate it as literally as possible while maintaining professional phrasing.

# Translation Guide for Key Sections

- **Executive Summary** -> 시스템 보안 진단 요약 보고서
- **Vulnerability Analysis** -> 취약점 분석 결과
- **Exploitation Evidence** -> 공격 증명 및 증거 데이터
- **Recommendation** -> 대응 방안 및 권고 사항
- **Verdict** -> 판정 (VULNERABLE: 취약 / SAFE: 안전)
- **Confidence** -> 신뢰도 (High: 높음 / Medium: 중간 / Low: 낮음)

# Consistency Rules

- **ALWAYS use the same Korean translation for the same English term** throughout the entire document.
- If you translate "SQL Injection" as "SQL 인젝션" in one section, use "SQL 인젝션" (not "SQL 주입") in all other sections.

Your response must be ONLY the translated Korean Markdown content. Do not include any introductory or concluding remarks.`;

/**
 * [목적] vLLM API URL 결정.
 */
const getApiUrl = () => (
  process.env.DOKODEMODOOR_VLLM_API_URL ||
  process.env.VLLM_BASE_URL ||
  'http://localhost:8000/v1'
);

/**
 * [목적] 번역 모델 이름 결정.
 */
const getModelName = () => (
  process.env.DOKODEMODOOR_VLLM_MODEL ||
  process.env.VLLM_MODEL ||
  'openai/gpt-oss-20b'
);

/**
 * [목적] 코드 블록 제거(언어 판별용).
 */
const stripCodeBlocks = (text) => text.replace(/```[\s\S]*?```/g, '').trim();

/**
 * [목적] 번역 불필요한 짧은 섹션 판별.
 */
const isLikelyNonTranslatable = (text) => {
  const stripped = stripCodeBlocks(text);
  return stripped.length < 200;
};

/**
 * [목적] 헤더 위치/이름 수집.
 */
const collectHeadingMatches = (content, regex) => {
  const matches = [];
  const lines = content.split('\n');
  let offset = 0;
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }

    if (!inCodeBlock) {
      const match = line.match(regex);
      if (match) {
        matches.push({ index: offset, name: match[1] });
      }
    }

    offset += line.length + 1;
  }

  return matches;
};

/**
 * [목적] 길이 제한에 맞게 문단 단위 분할.
 */
const splitByParagraphs = (content, maxSize, namePrefix) => {
  const chunks = [];
  const lines = content.split('\n');
  let current = '';
  let part = 1;
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }

    const next = current ? `${current}\n${line}` : line;
    const isParagraphBreak = !inCodeBlock && trimmed === '';

    if (isParagraphBreak && next.length > maxSize && current.length > 0) {
      chunks.push({ content: current, name: `${namePrefix} (Part ${part++})` });
      current = '';
    } else if (!isParagraphBreak && next.length > maxSize && current.length > 0) {
      chunks.push({ content: current, name: `${namePrefix} (Part ${part++})` });
      current = line;
    } else {
      current = next;
    }
  }

  if (current.trim()) {
    chunks.push({ content: current, name: `${namePrefix} (Part ${part})` });
  }

  return chunks;
};

/**
 * [목적] vLLM 호출로 섹션 번역.
 */
async function translateWithVLLM(content, sectionName) {
  const apiUrl = getApiUrl();
  const model = getModelName();

  console.log(chalk.cyan(`    🌐 Translating ${sectionName}...`));

  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model,
      messages: [{
        role: 'user',
        content: `${TRANSLATOR_PROMPT}

# CONTENT TO TRANSLATE

${content}

---

Please provide the Korean translation now:`
      }],
      max_tokens: 8192,
      temperature: 0.3,
      stream: false
    })
  });

  if (!response.ok) {
    throw new Error(`vLLM API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const translatedText = data.choices[0].message.content;

  console.log(chalk.green(`    ✅ Translated ${sectionName}`));

  return translatedText;
}

/**
 * [목적] 번역 스크립트 진입점.
 */
async function main() {
  const args = process.argv.slice(2);
  const fallbackPaths = [
    process.env.DOKODEMODOOR_REPORT_PATH,
    'deliverables/comprehensive_security_assessment_report.md',
    'repos/juice-shop/deliverables/comprehensive_security_assessment_report.md'
  ].filter(Boolean);

  let reportPath = args[0];
  if (!reportPath) {
    reportPath = fallbackPaths.find(p => fs.pathExistsSync(p));
  }

  if (!await fs.pathExists(reportPath)) {
    console.log(chalk.red(`❌ Report not found: ${reportPath}`));
    process.exit(1);
  }

  console.log(chalk.blue.bold('\n🌐 DokodemoDoor Report Translator (vLLM)\n'));
  console.log(chalk.gray(`📄 Source: ${reportPath}`));
  console.log(chalk.gray(`🤖 Model: ${getModelName()}`));
  console.log(chalk.gray(`🔗 API: ${getApiUrl()}\n`));

  const content = await fs.readFile(reportPath, 'utf8');

  // Split by SECTION headers for smaller chunks (better for local LLM)
  const sectionRegex = /^## SECTION: (.+)$/;
  const matches = collectHeadingMatches(content, sectionRegex);

  let rawSections = [];
  if (matches.length > 0) {
    const firstSection = content.substring(0, matches[0].index);
    if (firstSection.trim()) rawSections.push({ content: firstSection, name: 'Executive Summary' });
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index;
      const end = i < matches.length - 1 ? matches[i + 1].index : content.length;
      rawSections.push({ content: content.substring(start, end), name: matches[i].name });
    }
  } else {
    // Fallback: split by PHASE
    const phaseRegex = /^# PHASE: (.+)$/;
    const phaseMatches = collectHeadingMatches(content, phaseRegex);
    if (phaseMatches.length > 0) {
      const firstPhase = content.substring(0, phaseMatches[0].index);
      if (firstPhase.trim()) rawSections.push({ content: firstPhase, name: 'Introduction' });
      for (let i = 0; i < phaseMatches.length; i++) {
        const start = phaseMatches[i].index;
        const end = i < phaseMatches.length - 1 ? phaseMatches[i + 1].index : content.length;
        rawSections.push({ content: content.substring(start, end), name: phaseMatches[i].name });
      }
    } else {
      rawSections.push({ content: content, name: 'Full Report' });
    }
  }

  // SECONDARY SPLITTING: If a section is too large (> 8000 chars), split it into sub-chunks
  const sections = [];
  const MAX_CHUNK_SIZE = 8000;

  for (const section of rawSections) {
    if (section.content.length <= MAX_CHUNK_SIZE) {
      sections.push(section);
    } else {
      console.log(chalk.yellow(`    📎 Section '${section.name}' is too large (${section.content.length} chars). Splitting...`));

      // Try to split by H3 headers (###)
      const subRegex = /^### (.+)$/;
      const subMatches = collectHeadingMatches(section.content, subRegex);

      if (subMatches.length > 0) {
        // Add part before first H3
        const intro = section.content.substring(0, subMatches[0].index);
        if (intro.trim()) sections.push({ content: intro, name: `${section.name} (Intro)` });

        for (let i = 0; i < subMatches.length; i++) {
          const start = subMatches[i].index;
          const end = i < subMatches.length - 1 ? subMatches[i + 1].index : section.content.length;
          const chunkContent = section.content.substring(start, end);

          // If even a sub-section is too large, split by double newlines (paragraphs)
          if (chunkContent.length > MAX_CHUNK_SIZE) {
            const paraChunks = splitByParagraphs(
              chunkContent,
              MAX_CHUNK_SIZE,
              `${section.name} - ${subMatches[i].name}`
            );
            sections.push(...paraChunks);
          } else {
            sections.push({ content: chunkContent, name: `${section.name} - ${subMatches[i].name}` });
          }
        }
      } else {
        // No H3 headers, split by paragraphs with code-block awareness
        const paraChunks = splitByParagraphs(section.content, MAX_CHUNK_SIZE, section.name);
        sections.push(...paraChunks);
      }
    }
  }

  console.log(chalk.blue(`\n📊 Found ${sections.length} total chunks to translate\n`));

  const translatedSections = [];
  let successCount = 0;
  let failureCount = 0;
  let totalRetries = 0;

  for (let i = 0; i < sections.length; i++) {
    const { content: sectionContent, name: sectionTitle } = sections[i];
    const sectionName = `${sectionTitle} (${i + 1}/${sections.length})`;

    console.log(chalk.gray(`\n📝 ${sectionName}`));
    console.log(chalk.gray(`   Length: ${sectionContent.length} chars`));

    const MAX_RETRIES = 3;
    let translated = null;
    let lastError = null;

    // Retry loop: attempt translation up to MAX_RETRIES times
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          console.log(chalk.yellow(`    🔄 Retry attempt ${attempt}/${MAX_RETRIES}...`));
          totalRetries++;
          // Exponential backoff: 1s, 2s, 4s
          const backoffDelay = Math.pow(2, attempt - 1) * 1000;
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }

        translated = await translateWithVLLM(sectionContent, sectionName);

        // Validate translation is not empty and is actually Korean
        if (!translated || translated.trim().length === 0) {
          throw new Error('Empty translation received');
        }

        // Check if translation contains Korean characters (skip for code-heavy chunks)
        if (!isLikelyNonTranslatable(sectionContent)) {
          const hasKorean = /[가-힣]/.test(translated);
          if (!hasKorean) {
            throw new Error('Translation does not contain Korean characters');
          }
        }

        // Check if translation is suspiciously short (less than 30% of original)
        if (translated.length < sectionContent.length * 0.3) {
          throw new Error(`Translation too short (${translated.length} vs ${sectionContent.length} chars)`);
        }

        // Success! Break out of retry loop
        console.log(chalk.green(`    ✅ Translation successful (${translated.length} chars)`));
        successCount++;
        break;

      } catch (error) {
        lastError = error;
        console.log(chalk.yellow(`    ⚠️  Attempt ${attempt}/${MAX_RETRIES} failed: ${error.message}`));

        if (attempt === MAX_RETRIES) {
          console.log(chalk.red(`    ❌ All ${MAX_RETRIES} translation attempts failed`));
          console.log(chalk.gray(`    📋 Keeping original English content for this section`));
          translated = null; // Ensure we use original content
          failureCount++;
        }
      }
    }

    // Add translated or original content
    if (translated && translated.trim().length > 0) {
      translatedSections.push(translated);
    } else {
      console.log(chalk.yellow(`    ⚠️  Using original English content (translation failed after ${MAX_RETRIES} attempts)`));
      translatedSections.push(sectionContent);
    }

    // Small delay to avoid overwhelming the server
    if (i < sections.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.log(chalk.blue(`\n📊 Translation summary:`));
  console.log(chalk.gray(`   Total sections: ${sections.length}`));
  console.log(chalk.green(`   ✅ Successfully translated to Korean: ${successCount}`));
  console.log(chalk.yellow(`   ⚠️  Kept in English (failed): ${failureCount}`));
  console.log(chalk.gray(`   🔄 Total retry attempts: ${totalRetries}`));
  console.log(chalk.gray(`   📝 Total output length: ${translatedSections.reduce((sum, s) => sum + s.length, 0)} chars\n`));

  const finalTranslation = translatedSections.join('\n\n');
  const parsedPath = path.parse(reportPath);
  const outputPath = path.join(parsedPath.dir, `${parsedPath.name}_kr${parsedPath.ext || '.md'}`);

  await fs.writeFile(outputPath, finalTranslation);

  console.log(chalk.green.bold(`\n✅ Translation complete!`));
  console.log(chalk.cyan(`📄 Korean report: ${outputPath}\n`));
}

main().catch(error => {
  console.error(chalk.red(`\n❌ Error: ${error.message}\n`));
  process.exit(1);
});
