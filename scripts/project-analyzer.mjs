import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import { $ } from 'zx';
import { glob } from 'glob';
import { config as envConfig } from '../src/config/env.js';

const MAX_ROUTE_LINES = 140;
const MAX_MATCH_LINES = 80;
const MAX_FILE_CHARS = 2400;
const MAX_CONTEXT_CHARS = 14000;
const MAX_SPEC_FILES = 6;

const [repoPathArg] = process.argv.slice(2);

if (!repoPathArg) {
  console.error('Usage: node scripts/project-analyzer.mjs <project_path>');
  process.exit(1);
}

const repoPath = path.resolve(repoPathArg);

const fileExists = async (filePath) => {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
};

if (!await fileExists(repoPath)) {
  console.error(`Repository path not found: ${repoPath}`);
  process.exit(1);
}

const readFileLimited = async (filePath, maxChars = MAX_FILE_CHARS) => {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    if (content.length <= maxChars) return content;
    return `${content.slice(0, maxChars)}\n... (truncated)`;
  } catch {
    return null;
  }
};

const takeLines = (text, maxLines) => {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join('\n')}\n... (truncated)`;
};

const hasCommand = async (cmd) => {
  try {
    await $`command -v ${cmd}`;
    return true;
  } catch {
    return false;
  }
};

const hasRipgrep = await hasCommand('rg');

const runSearch = async (pattern, options = []) => {
  try {
    if (hasRipgrep) {
      const result = await $`rg -n --no-heading -S ${options} ${pattern} ${repoPath}`;
      return result.stdout || '';
    }
    const result = await $`grep -R -n --binary-files=without-match ${options} ${pattern} ${repoPath}`;
    return result.stdout || '';
  } catch {
    return '';
  }
};

const runSearchTokens = async (tokens, options = []) => {
  const outputs = [];
  for (const token of tokens) {
    const out = await runSearch(token, ['-F', ...options]);
    if (out) outputs.push(out);
  }
  return outputs.join('\n');
};

const runSearchFiles = async (globsList) => {
  try {
    if (hasRipgrep) {
      const result = await $`rg --files ${globsList.map(g => ['-g', g]).flat()} ${repoPath}`;
      return (result.stdout || '').split('\n').filter(Boolean);
    }
    return await glob(globsList, { cwd: repoPath, absolute: true, nodir: true });
  } catch {
    return [];
  }
};

const gatherRepoContext = async () => {
  const context = [];

  const readmePath = path.join(repoPath, 'README.md');
  const packagePath = path.join(repoPath, 'package.json');

  const readme = await readFileLimited(readmePath, 4000);
  if (readme) context.push(`README.md (truncated)\n${readme}`);

  const pkg = await readFileLimited(packagePath, 2400);
  if (pkg) context.push(`package.json (truncated)\n${pkg}`);

  const specFiles = await runSearchFiles([
    'Dockerfile',
    'docker-compose*.yml',
    'docker-compose*.yaml',
    '.env.example',
    '.env.sample',
    'config/*.yml',
    'config/*.yaml',
    'configs/*.yml',
    'configs/*.yaml',
    'openapi*.yml',
    'openapi*.yaml',
    'openapi*.json',
    'swagger*.yml',
    'swagger*.yaml',
    'swagger*.json'
  ]);

  for (const filePath of specFiles.slice(0, MAX_SPEC_FILES)) {
    const content = await readFileLimited(filePath, 2400);
    if (content) {
      const rel = path.relative(repoPath, filePath);
      context.push(`${rel} (truncated)\n${content}`);
    }
  }

  const routeMatches = await runSearchTokens([
    'app.get(',
    'app.post(',
    'app.put(',
    'app.delete(',
    'app.patch(',
    'router.get(',
    'router.post(',
    'router.put(',
    'router.delete(',
    'router.patch(',
    '@Get(',
    '@Post(',
    '@Put(',
    '@Delete(',
    '@Patch(',
    'fastify.',
    'koa-router',
    'express(',
    'router ='
  ]);
  if (routeMatches) {
    context.push(`Route-related matches (truncated)\n${takeLines(routeMatches, MAX_ROUTE_LINES)}`);
  }

  const authMatches = await runSearchTokens([
    'login',
    'signin',
    'auth',
    'session',
    'token',
    'logout',
    'password',
    'mfa',
    '2fa'
  ]);
  if (authMatches) {
    context.push(`Auth-related matches (truncated)\n${takeLines(authMatches, MAX_MATCH_LINES)}`);
  }

  const apiMatches = await runSearchTokens([
    'openapi',
    'swagger',
    '/api/',
    '/admin',
    '/auth'
  ]);
  if (apiMatches) {
    context.push(`OpenAPI/Swagger/API matches (truncated)\n${takeLines(apiMatches, MAX_MATCH_LINES)}`);
  }

  const joined = context.join('\n\n---\n\n');
  if (joined.length <= MAX_CONTEXT_CHARS) return joined;
  return `${joined.slice(0, MAX_CONTEXT_CHARS)}\n... (truncated)`;
};

const systemPromptPath = path.resolve('analyzer/analyzer_prompts.txt');
const systemPrompt = await readFileLimited(systemPromptPath, 16000);
if (!systemPrompt) {
  console.error(`System prompt not found: ${systemPromptPath}`);
  process.exit(1);
}

const repoContext = await gatherRepoContext();
const userPrompt = [
  `Repository path: ${repoPath}`,
  '',
  'Repository context:',
  repoContext || '(no context extracted)'
].join('\n');

const client = new OpenAI({
  apiKey: envConfig.llm.vllm.apiKey,
  baseURL: envConfig.llm.vllm.baseURL
});

const requestLLM = async () => {
  return client.chat.completions.create({
    model: envConfig.llm.vllm.model,
    temperature: 0.2,
    max_tokens: 1800,
    response_format: { type: 'text' },
    messages: [
      { role: 'system', content: systemPrompt.trim() },
      { role: 'user', content: userPrompt }
    ]
  });
};

let response = await requestLLM();
let content = response.choices?.[0]?.message?.content?.trim()
  || response.choices?.[0]?.text?.trim();

if (!content) {
  console.error('No content returned from LLM.');
  console.error(`Raw choice: ${JSON.stringify(response.choices?.[0] || {}, null, 2)}`);
  process.exit(1);
}

const stripCodeFences = (text) => {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  }
  return trimmed;
};

const cleanedContent = stripCodeFences(content);

const repoBase = path.basename(repoPath);
const outputDir = path.resolve('analyzer', 'result');
const outputPath = path.join(outputDir, `${repoBase}-analyze.txt`);

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(outputPath, `${cleanedContent}\n`, 'utf8');

console.log(`Saved analysis to ${outputPath}`);
