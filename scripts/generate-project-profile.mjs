import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import yaml from 'js-yaml';
import { $ } from 'zx';
import { fileURLToPath } from 'url';
import { config as envConfig } from '../src/config/env.js';

// --- Constants & Config ---
const MAX_RULES = 12;
const MAX_CONTEXT_CHARS = 8000;
const MAX_SPEC_FILES = 4;

const [repoPathArg, loginUrl, username, password, otp] = process.argv.slice(2);

if (!repoPathArg || !loginUrl || !username || !password) {
  console.error('Usage: node scripts/generate-project-profile.mjs <repo_path> <login_url> <id> <pw> [otp]');
  process.exit(1);
}

const repoPath = path.resolve(repoPathArg);
const otpValue = otp?.trim() || null;

// --- Authentication (Hardcoded as per user request) ---
const buildDefaultLoginFlow = (url, user, pass, otp) => {
  const flow = [
    `1. Navigate to ${url}`,
    "2. (If Popup) Dismiss Welcome Modal: Click 'Close Welcome Banner'. If it is not visible or click times out once, note it and continue.",
    "3. (If Popup) Dismiss Cookie Banner: Click 'Me want it!'. If it is not visible or click times out once, note it and continue.",
    `4. Enter Email: Click input#email first to focus, then type '${user}'.`,
    `5. Enter Password: Click input#password first to focus, then type '${pass}'.`,
    "6. Enable Login Button: Press 'Tab' (browser_press_key) to trigger Angular validation. Ensure button#loginButton is no longer disabled.",
    '7. Click Login: Click button#loginButton.'
  ];

  if (otp) {
    flow.push(`8. Enter TOTP: Since 2FA is enabled, wait for the TOTP input field to appear and type '${otp}'.`);
    flow.push('9. Submit TOTP: Click the 2FA verify/login button.');
    flow.push("10. Confirm: Wait for URL to include '/#/search'.");
  } else {
    flow.push("8. Confirm: Wait for URL to include '/#/search'.");
  }
  return flow;
};

const authentication = {
  login_type: 'form',
  login_url: loginUrl,
  credentials: {
    username,
    password,
    ...(otpValue ? { totp_code: otpValue } : {})
  },
  login_flow: buildDefaultLoginFlow(loginUrl, username, password, otpValue),
  success_condition: { type: 'url_contains', value: '/#/search' }
};

// --- Utilities ---
const runRg = async (pattern, options = []) => {
  try {
    const result = await $`rg -n --no-heading -S ${options} ${pattern} ${repoPath}`;
    return result.stdout || '';
  } catch { return ''; }
};

const runRgTokens = async (tokens, maxLines = 80) => {
  const outputs = [];
  for (const token of tokens) {
    const out = await runRg(token, ['-F']);
    if (out) outputs.push(out);
  }
  const full = outputs.join('\n');
  const lines = full.split('\n');
  return lines.length > maxLines ? lines.slice(0, maxLines).join('\n') + '\n... (truncated)' : full;
};

const runSemgrep = async (pattern, lang = 'javascript') => {
  try {
    const result = await $`semgrep --quiet --json --lang ${lang} -e ${pattern} ${repoPath}`;
    const data = JSON.parse(result.stdout);
    return data.results || [];
  } catch { return []; }
};

const gatherRepoContext = async () => {
  const context = [];
  try {
    const manifests = ['package.json', 'README.md', 'requirements.txt', 'pom.xml', 'go.mod', 'Gemfile', 'Docker-compose.yml'];
    for (const f of manifests) {
      const p = path.join(repoPath, f);
      const c = await fs.readFile(p, 'utf8').catch(() => null);
      if (c) context.push(`${f}:\n${c.slice(0, 1500)}`);
    }

    // High-level architecture hints via common patterns
    const architecturalTriggers = [
      'module.exports', '@Component', '@Controller', '@RestController', // JS/TS & Java
      'def ', 'class ', // Python/Ruby
      'func ', 'package ' // Go
    ];
    const matches = await runRgTokens(architecturalTriggers, 100);
    if (matches) context.push(`Architecture Clues (Selected Code):\n${matches}`);

    // Cross-language Security Points via Semgrep
    const securityPatterns = [
      'jwt.verify(...)', 'session', 'cookie',
      'db.query(...)', 'SELECT ... FROM', 'INSERT INTO', // DB logic
      'fs.readFile(...)', 'open(...)', // File logic
      'permission', 'authorize', 'role' // Auth logic
    ];
    const securityPoints = await runSemgrep(securityPatterns.join(' || '));
    if (securityPoints.length > 0) {
      const snippets = securityPoints.slice(0, 15).map(r => `File: ${r.path}\nLines: ${r.extra.lines}`).join('\n\n');
      context.push(`Security-Sensitive Logic Found (Semgrep):\n${snippets}`);
    }
  } catch (e) {
    console.warn('Context gathering partially failed');
  }
  return context.join('\n\n---\n\n').slice(0, MAX_CONTEXT_CHARS);
};

const loadOpenApiPaths = async () => {
  try {
    const result = await $`rg --files -g "*openapi*.{yml,yaml,json}" -g "*swagger*.{yml,yaml,json}" ${repoPath}`;
    const files = result.stdout.split('\n').filter(Boolean).slice(0, MAX_SPEC_FILES);
    const paths = [];
    for (const f of files) {
      const content = await fs.readFile(f, 'utf8');
      const doc = yaml.load(content);
      if (doc?.paths) {
        for (const [p, methods] of Object.entries(doc.paths)) {
          paths.push({ path: p, methods: Object.keys(methods).map(m => m.toUpperCase()) });
        }
      }
    }
    return paths;
  } catch { return []; }
};

const parseCodeRoutes = async () => {
  const routes = [];

  const frameworks = [
    { name: 'Express/JS', pattern: 'app.$METHOD($PATH, ...)', lang: 'javascript' },
    { name: 'Flask/Python', pattern: '@app.route($PATH, methods=[$METHOD])', lang: 'python' },
    { name: 'Django/Python', pattern: 'path($PATH, ...)', lang: 'python' },
    { name: 'Spring/Java', pattern: '@$REQ_MAPPING($PATH)', lang: 'java' },
    { name: 'Gin/Go', pattern: '$ENGINE.$METHOD($PATH, ...)', lang: 'go' }
  ];

  for (const fw of frameworks) {
    const pattern = fw.pattern || '$OBJ.$METHOD($PATH, ...)';
    const fwMatches = await runSemgrep(pattern, fw.lang);
    fwMatches.forEach(m => {
      const pathValue = m.extra?.metavars?.['$PATH']?.abstract_content;
      if (pathValue && typeof pathValue === 'string' && pathValue.startsWith('/')) {
        routes.push({ path: pathValue.replace(/['"`]/g, '').split('?')[0], methods: ['API'] });
      }
    });
  }

  // Fallback broad regex for path patterns
  const text = await runRgTokens(['/', '"/', "'/"], 300);
  const regex = /['"`](\/(?:api|rest|v[0-9]|auth|user|admin|order|product|file|upload|profile|metrics|snippets|gql)[^'"`\s?)]*)/gi;
  let m;
  while ((m = regex.exec(text)) !== null) {
    routes.push({ path: m[1], methods: ['SCAN'] });
  }
  return routes;
};

// --- Core Mapping ---
const buildRouteTree = (routes) => {
  const tree = {};
  for (const r of routes) {
    const parts = r.path.split('/').filter(Boolean);
    let curr = tree;
    for (let i = 0; i < Math.min(parts.length, 3); i++) {
      if (!curr[parts[i]]) curr[parts[i]] = {};
      curr = curr[parts[i]];
    }
  }
  return tree;
};

const normalizeRule = (rule, fallback) => {
  if (!rule || typeof rule !== 'object') return null;
  const urlPath = (rule.url_path || rule.urlPath || '').trim();
  const description = (rule.description || fallback || '').trim();
  if (!urlPath || !description) return null;
  return {
    description,
    type: 'path',
    url_path: urlPath.startsWith('/') ? urlPath : '/' + urlPath
  };
};

// --- Main Execution ---
async function main() {
  console.log(`🔍 Analyzing repository: ${repoPath}...`);

  const repoContext = await gatherRepoContext();
  const openApiRoutes = await loadOpenApiPaths();
  const codeRoutes = await parseCodeRoutes();

  // Merge sources
  const routeMap = new Map();
  [...openApiRoutes, ...codeRoutes].forEach(r => {
    if (!routeMap.has(r.path)) routeMap.set(r.path, { path: r.path, methods: new Set() });
    r.methods.forEach(m => routeMap.get(r.path).methods.add(m));
  });

  const allRoutes = Array.from(routeMap.values()).map(r => ({ ...r, methods: Array.from(r.methods) }));
  const routeTree = buildRouteTree(allRoutes);

  // LLM Logic
  const client = new OpenAI({ apiKey: envConfig.llm.vllm.apiKey, baseURL: envConfig.llm.vllm.baseURL });

  const systemPrompt = [
    'Role: Senior Security Architect & YAML Generator.',
    'TASK: Return ONLY a YAML object with a "rules" key containing "focus" and "avoid" lists.',
    'INSTRUCTION: Identify 5-10 logical architectural groups (e.g., /api/user/*, /rest/admin/*) based on the provided data.',
    '1. Each group MUST have a tech-heavy 2-3 sentence description of security risks.',
    '2. Use simple * wildcards in "url_path". Do NOT use "|" or regex pipes.',
    '3. Do NOT hallucinate. Use ONLY provided routes.',
    '4. Output ONLY the YAML. No conversational text.',
    'Format Example:',
    'rules:',
    '  focus:',
    '    - url_path: "/api/v1/*"',
    '      description: "Detailed security analysis..."',
    '  avoid: []'
  ].join('\n');

  const userPrompt = [
    `Project: ${path.basename(repoPath)}`,
    `Structural Route Tree (High Level):\n${JSON.stringify(routeTree, null, 2)}`,
    `Detailed Sample Routes (Top 50):\n${JSON.stringify(allRoutes.slice(0, 50), null, 2)}`,
    `Repo Context:\n${repoContext}`
  ].join('\n\n');

  console.log('🤖 Requesting AI analysis...');
  const response = await client.chat.completions.create({
    model: envConfig.llm.vllm.model,
    temperature: 0,
    max_tokens: 4000,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]
  });

  const content = response.choices?.[0]?.message?.content?.trim() || response.choices?.[0]?.text?.trim() || '';

  const extractYaml = (text) => {
    // Try to find content between triple backticks
    const match = text.match(/```(?:yaml)?\s*([\s\S]*?)```/);
    if (match) return match[1].trim();

    // Otherwise, try to find the start of the 'rules:' key
    const rulesIdx = text.indexOf('rules:');
    if (rulesIdx !== -1) return text.slice(rulesIdx).trim();

    return text.trim();
  };

  const cleanedContent = extractYaml(content);
  console.log('--- EXTRACTED YAML ---');
  console.log(cleanedContent);
  console.log('---------------------');

  let parsed = {};
  try {
    parsed = yaml.load(cleanedContent) || {};
  } catch (e) {
    console.error(`❌ YAML Parsing Error: ${e.message}`);
    // If it fails, maybe it's just the content without the top-level 'rules:' key
    try {
      const wrapped = `rules:\n${cleanedContent.split('\n').map(l => '  ' + l).join('\n')}`;
      parsed = yaml.load(wrapped) || {};
      console.log('💡 Recovered by wrapping in "rules:" key');
    } catch (e2) {
      console.error('❌ Recovery failed. Using fallback.');
    }
  }

  const rawRules = parsed.rules || (parsed.focus ? parsed : { focus: [], avoid: [] });
  const rules = {
    focus: (rawRules.focus || []).map(r => normalizeRule(r, 'Focus area')).filter(Boolean),
    avoid: (rawRules.avoid || []).map(r => normalizeRule(r, 'Avoid area')).filter(Boolean)
  };

  // Fallback if AI fails
  if (rules.focus.length === 0) {
    console.warn('⚠️ AI analysis failed. Using fallback grouping.');
    const prefixes = new Set(allRoutes.map(r => r.path.split('/').slice(0, 3).join('/') + '/*'));
    rules.focus = Array.from(prefixes).slice(0, MAX_RULES).map(p => ({
      description: `[Fallback] Group around ${p}.`,
      type: 'path',
      url_path: p
    }));
  }

  if (rules.avoid.length === 0) {
    rules.avoid = [
      { description: 'Static assets', type: 'path', url_path: '/static/*' },
      { description: 'Logout endpoints', type: 'path', url_path: '/logout*' }
    ];
  }

  const output = yaml.dump({ authentication, rules: {
    focus: rules.focus.slice(0, MAX_RULES),
    avoid: rules.avoid.slice(0, MAX_RULES)
  }}, { lineWidth: -1, quotingType: '"', forceQuotes: true });

  const outputPath = path.join(path.dirname(fileURLToPath(import.meta.url)), `../configs/profile/${path.basename(repoPath)}.yaml`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, output, 'utf8');

  console.log(`✅ Generated ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
