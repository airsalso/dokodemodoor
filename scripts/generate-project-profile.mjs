import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import yaml from 'js-yaml';
import { $ } from 'zx';
import { fileURLToPath } from 'url';
import { config as envConfig } from '../src/config/env.js';

const MAX_ROUTE_LINES = 120;
const MAX_MATCH_LINES = 80;
const MAX_FILE_CHARS = 2000;
const MAX_CONTEXT_CHARS = 8000;
const MAX_RULES = 12;
const MAX_SPEC_FILES = 4;

const buildDefaultLoginFlow = (loginUrlValue, usernameValue, passwordValue) => ([
  `1. Navigate to ${loginUrlValue}`,
  "2. (If Popup) Dismiss Welcome Modal: Click 'Close Welcome Banner'. If it is not visible or click times out once, note it and continue.",
  "3. (If Popup) Dismiss Cookie Banner: Click 'Me want it!'. If it is not visible or click times out once, note it and continue.",
  `4. Enter Email: Click input#email first to focus, then type '${usernameValue}'.`,
  `5. Enter Password: Click input#password first to focus, then type '${passwordValue}'.`,
  "6. Enable Login Button: Press 'Tab' (browser_press_key) to trigger Angular validation. Ensure button#loginButton is no longer disabled.",
  '7. Click Login: Click button#loginButton.',
  "8. Confirm: Wait for URL to include '/#/search'."
]);

const DEFAULT_SUCCESS_CONDITION = {
  type: 'url_contains',
  value: '/#/search'
};

const [repoPathArg, loginUrl, username, password, otp] = process.argv.slice(2);

if (!repoPathArg || !loginUrl || !username || !password) {
  console.error('Usage: node scripts/generate-project-profile.mjs <repo_path> <login_url> <id> <pw> [otp]');
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

const runRg = async (pattern, options = []) => {
  try {
    const result = await $`rg -n --no-heading -S ${options} ${pattern} ${repoPath}`;
    return result.stdout || '';
  } catch {
    return '';
  }
};

const runRgTokens = async (tokens, options = []) => {
  const outputs = [];
  for (const token of tokens) {
    const out = await runRg(token, ['-F', ...options]);
    if (out) outputs.push(out);
  }
  return outputs.join('\n');
};

const runRgFiles = async (globs) => {
  try {
    const result = await $`rg --files ${globs.map(g => ['-g', g]).flat()} ${repoPath}`;
    return (result.stdout || '').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

const gatherRepoContext = async () => {
  const context = [];

  const readmePath = path.join(repoPath, 'README.md');
  const packagePath = path.join(repoPath, 'package.json');

  const readme = await readFileLimited(readmePath, 3000);
  if (readme) {
    context.push(`README.md (truncated)\n${readme}`);
  }

  const pkg = await readFileLimited(packagePath, 2000);
  if (pkg) {
    context.push(`package.json (truncated)\n${pkg}`);
  }

  const routeMatches = await runRgTokens([
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

  const deleteMatches = await runRgTokens([
    'delete(',
    'destroy(',
    'hardDelete',
    'hard-delete',
    'remove('
  ]);
  if (deleteMatches) {
    context.push(`Delete-related matches (truncated)\n${takeLines(deleteMatches, MAX_MATCH_LINES)}`);
  }

  const authMatches = await runRgTokens([
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

  const openapiMatches = await runRgTokens([
    'openapi',
    'swagger',
    '/api/'
  ]);
  if (openapiMatches) {
    context.push(`OpenAPI/Swagger/API matches (truncated)\n${takeLines(openapiMatches, MAX_MATCH_LINES)}`);
  }

  const joined = context.join('\n\n---\n\n');
  if (joined.length <= MAX_CONTEXT_CHARS) return joined;
  return `${joined.slice(0, MAX_CONTEXT_CHARS)}\n... (truncated)`;
};

const normalizeOtp = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed;
};

const otpValue = normalizeOtp(otp);

const repoContext = await gatherRepoContext();

const extractPaths = (text) => {
  if (!text) return [];
  const paths = new Set();
  const regex = /['"`](\/(?:api|rest|graphql|gql|v1|v2)[^'"`\s)]*)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const value = match[1].trim();
    if (value.length > 1) paths.add(value);
  }
  return Array.from(paths);
};

const loadOpenApiPaths = async () => {
  const specFiles = await runRgFiles([
    '*openapi*.yml',
    '*openapi*.yaml',
    '*openapi*.json',
    '*swagger*.yml',
    '*swagger*.yaml',
    '*swagger*.json'
  ]);

  const selected = specFiles.slice(0, MAX_SPEC_FILES);
  const results = [];

  for (const filePath of selected) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const doc = yaml.load(content);
      const pathsObj = doc?.paths || {};
      for (const [p, methods] of Object.entries(pathsObj)) {
        if (typeof p !== 'string') continue;
        const methodList = methods && typeof methods === 'object'
          ? Object.keys(methods).map(m => m.toUpperCase())
          : [];
        results.push({ path: p, methods: methodList });
      }
    } catch {
      continue;
    }
  }

  return results;
};

const parseRouteLines = (text) => {
  if (!text) return [];
  const routes = [];
  const lines = text.split('\n');
  const regex = /(app|router)\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/i;
  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      routes.push({
        path: match[3],
        methods: [match[2].toUpperCase()]
      });
    }
  }
  return routes;
};

const routeLines = await runRgTokens([
  'app.get(',
  'app.post(',
  'app.put(',
  'app.delete(',
  'app.patch(',
  'router.get(',
  'router.post(',
  'router.put(',
  'router.delete(',
  'router.patch('
]);

const openApiRoutes = await loadOpenApiPaths();
const codeRoutes = parseRouteLines(routeLines);

const mergeRouteSources = () => {
  const map = new Map();

  for (const route of openApiRoutes) {
    if (!route?.path || typeof route.path !== 'string') continue;
    const key = route.path;
    const entry = map.get(key) || { path: key, methods: new Set(), source: new Set() };
    (route.methods || []).forEach(m => entry.methods.add(m));
    entry.source.add('openapi');
    map.set(key, entry);
  }

  for (const route of codeRoutes) {
    if (!route?.path || typeof route.path !== 'string') continue;
    const key = route.path;
    const entry = map.get(key) || { path: key, methods: new Set(), source: new Set() };
    (route.methods || []).forEach(m => entry.methods.add(m));
    entry.source.add('code');
    map.set(key, entry);
  }

  for (const p of extractPaths(repoContext)) {
    const entry = map.get(p) || { path: p, methods: new Set(), source: new Set() };
    entry.source.add('context');
    map.set(p, entry);
  }

  return Array.from(map.values()).map(entry => ({
    path: entry.path,
    methods: Array.from(entry.methods),
    source: Array.from(entry.source)
  }));
};

const routeCandidates = mergeRouteSources();

const KEYWORDS = [
  { key: 'auth', score: 5, description: 'Authentication and session endpoints' },
  { key: 'login', score: 5, description: 'Authentication and session endpoints' },
  { key: 'token', score: 4, description: 'Token and session handling' },
  { key: 'user', score: 4, description: 'User and permission related APIs' },
  { key: 'admin', score: 4, description: 'Admin and privileged endpoints' },
  { key: 'role', score: 3, description: 'Role and permission management' },
  { key: 'payment', score: 4, description: 'Payment and billing flows' },
  { key: 'card', score: 4, description: 'Payment and card management' },
  { key: 'billing', score: 3, description: 'Payment and billing flows' },
  { key: 'order', score: 3, description: 'Order and checkout flows' },
  { key: 'checkout', score: 3, description: 'Order and checkout flows' },
  { key: 'cart', score: 3, description: 'Cart and basket operations' },
  { key: 'basket', score: 3, description: 'Cart and basket operations' },
  { key: 'search', score: 3, description: 'Search and query endpoints' },
  { key: 'query', score: 2, description: 'Search and query endpoints' },
  { key: 'report', score: 2, description: 'Reporting and export endpoints' },
  { key: 'upload', score: 3, description: 'File upload endpoints' },
  { key: 'file', score: 2, description: 'File and media endpoints' }
];

const scoreFocusPath = (pathValue) => {
  let score = 0;
  const lower = pathValue.toLowerCase();
  for (const rule of KEYWORDS) {
    if (lower.includes(`/${rule.key}`) || lower.includes(rule.key)) {
      score += rule.score;
    }
  }
  if (lower.includes('/api/')) score += 1;
  if (lower.includes('/rest/')) score += 1;
  return score;
};

const describePath = (pathValue) => {
  const lower = pathValue.toLowerCase();
  for (const rule of KEYWORDS) {
    if (lower.includes(`/${rule.key}`) || lower.includes(rule.key)) {
      return rule.description;
    }
  }
  return `Focus on ${pathValue}`;
};

const buildFallbackFocus = (paths) => {
  return paths
    .map(p => ({ path: p, score: scoreFocusPath(p) }))
    .sort((a, b) => b.score - a.score)
    .filter(entry => entry.score > 0)
    .slice(0, MAX_RULES)
    .map(entry => ({
      description: describePath(entry.path),
      type: 'path',
      url_path: entry.path
    }));
};

const buildFallbackAvoid = (paths) => {
  const unique = Array.from(new Set(paths));
  return unique.slice(0, MAX_RULES).map(p => ({
    description: 'Avoid destructive delete operation',
    type: 'path',
    url_path: p
  }));
};

const client = new OpenAI({
  apiKey: envConfig.llm.vllm.apiKey,
  baseURL: envConfig.llm.vllm.baseURL
});

const systemPrompt = [
  'You generate a DokodemoDoor profile config.',
  'Return YAML only (no code fences).',
  'Include only: authentication, rules.',
  'Use provided credentials exactly.',
  'Login flow and success_condition are fixed by the caller; do not invent alternatives.',
  'Prioritize OpenAPI/Swagger paths, then code routes, then README hints.',
  'Focus rules should include descriptions plus path patterns (url_path).',
  'Avoid rules should include destructive endpoints and logout/static paths when found.',
  'For each focus rule description, write a concise but comprehensive sentence that explains what the endpoint is, how it fits into the application structure, and how it should behave under normal usage.',
  'Think like a solution architect and a security engineer preparing background for black-box testing.',
  'Mention authentication or role expectations when strongly implied by the path/context; avoid speculation.',
  'Keep output concise, but make descriptions meaningful (prefer 2-3 sentences over fragments).'
].join(' ');

const userPrompt = [
  `Repository path: ${repoPath}`,
  `Login URL: ${loginUrl}`,
  `Credentials: username=${username}, password=${password}${otpValue ? `, totp_code=${otpValue}` : ''}`,
  `Route candidates (paths/methods): ${JSON.stringify(routeCandidates.slice(0, 50))}`,
  '',
  'Repository context:',
  repoContext || '(no context extracted)'
].join('\n');

const requestLLM = async (prompt, user) => {
  return client.chat.completions.create({
    model: envConfig.llm.vllm.model,
    temperature: 0.2,
    max_tokens: 1200,
    response_format: { type: 'text' },
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: user }
    ]
  });
};

let response = await requestLLM(systemPrompt, userPrompt);
let content = response.choices?.[0]?.message?.content?.trim()
  || response.choices?.[0]?.text?.trim();

if (!content) {
  const shortContext = repoContext ? `${repoContext.slice(0, 3000)}\n... (truncated)` : '(no context extracted)';
  const retryUserPrompt = [
    `Repository path: ${repoPath}`,
    `Login URL: ${loginUrl}`,
    `Credentials: username=${username}, password=${password}${otpValue ? `, totp_code=${otpValue}` : ''}`,
    '',
    'Repository context:',
    shortContext
  ].join('\n');
  const retrySystemPrompt = [
    'Return only YAML in the assistant content (no reasoning).',
    'Include only: authentication, rules.',
    'Use provided credentials exactly.',
    'Login flow and success_condition are fixed by the caller; do not invent alternatives.',
    'Focus rules should include descriptions plus path patterns (url_path).',
    'Avoid rules should include destructive endpoints (DELETE, hard-delete, admin deletes) when found.',
    'For each focus rule description, write a concise but comprehensive sentence that explains what the endpoint is, how it fits into the application structure, and how it should behave under normal usage.',
    'Think like a solution architect and a security engineer preparing background for black-box testing.',
    'Mention authentication or role expectations when strongly implied by the path/context; avoid speculation.',
    'Keep output concise, but make descriptions meaningful (prefer 2-3 sentences over fragments).'
  ].join(' ');

  response = await requestLLM(retrySystemPrompt, retryUserPrompt);
  content = response.choices?.[0]?.message?.content?.trim()
    || response.choices?.[0]?.text?.trim();
}

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

let parsed;
try {
  parsed = yaml.load(cleanedContent);
} catch (err) {
  console.error(`Generated YAML is invalid: ${err.message}`);
  process.exit(1);
}

if (!parsed || typeof parsed !== 'object') {
  console.error('Generated YAML did not produce a valid object.');
  process.exit(1);
}

const authentication = {
  login_type: 'form',
  login_url: loginUrl,
  credentials: {
    username,
    password,
    ...(otpValue ? { totp_code: otpValue } : {})
  },
  login_flow: buildDefaultLoginFlow(loginUrl, username, password),
  success_condition: DEFAULT_SUCCESS_CONDITION
};

const normalizeRule = (rule, fallbackDescription) => {
  if (!rule || typeof rule !== 'object') return null;
  const description = (rule.description || fallbackDescription || '').trim();
  const urlPath = String(rule.url_path || rule.urlPath || '').trim();
  let type = (rule.type || '').toString().trim().toLowerCase();

  if (!type && rule.method) {
    type = 'method';
  }

  if (!type) {
    type = urlPath.startsWith('/') ? 'path' : 'path';
  }

  const methodCandidate = String(rule.method || urlPath || '').trim().toUpperCase();
  const isHttpMethod = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(methodCandidate);
  if (!rule.type && isHttpMethod) {
    type = 'method';
  }

  const finalUrlPath = type === 'method'
    ? methodCandidate
    : urlPath;

  if (!description || !finalUrlPath) return null;

  return {
    description,
    type,
    url_path: finalUrlPath
  };
};

const rawRules = parsed.rules || { avoid: [], focus: [] };
const rawAvoid = Array.isArray(rawRules.avoid) ? rawRules.avoid : [];
const rawFocus = Array.isArray(rawRules.focus) ? rawRules.focus : [];

const rules = {
  avoid: rawAvoid
    .map(rule => normalizeRule(rule, 'Avoid risky operation'))
    .filter(Boolean)
    .filter(rule => rule.type === 'path'),
  focus: rawFocus
    .map(rule => normalizeRule(rule, 'Focus area'))
    .filter(Boolean)
};

const allPaths = routeCandidates.map(c => c.path);
const deletePaths = allPaths.filter(p => /delete|destroy|remove/.test(p.toLowerCase()));
const logoutPaths = allPaths.filter(p => /logout|signout|sign-out|sign_out/.test(p.toLowerCase()));
const staticPaths = allPaths.filter(p => /\/assets|\/static|\/public|\/build|\/dist|\/favicon/.test(p.toLowerCase()));

if (rules.avoid.length === 0) {
  const avoidFallback = [
    ...logoutPaths.map(p => ({ description: 'Avoid logout endpoints', type: 'path', url_path: p })),
    ...staticPaths.map(p => ({ description: 'Avoid static assets', type: 'path', url_path: p }))
  ];
  if (avoidFallback.length === 0) {
    avoidFallback.push({
      description: 'Avoid static assets and logout endpoints',
      type: 'path',
      url_path: '/assets/*'
    });
    avoidFallback.push({
      description: 'Avoid static assets and logout endpoints',
      type: 'path',
      url_path: '/static/*'
    });
    avoidFallback.push({
      description: 'Avoid static assets and logout endpoints',
      type: 'path',
      url_path: '/logout*'
    });
  }
  rules.avoid = avoidFallback;
}

if (rules.focus.length === 0 || rules.focus.every(rule => rule.type === 'method')) {
  const focusFallback = buildFallbackFocus(allPaths);
  rules.focus = focusFallback.length ? focusFallback : rules.focus;
}

rules.avoid = rules.avoid.slice(0, MAX_RULES);
rules.focus = rules.focus.slice(0, MAX_RULES);

const finalConfig = {
  authentication,
  rules
};

const output = yaml.dump(finalConfig, {
  lineWidth: -1,
  noRefs: true,
  quotingType: '"',
  forceQuotes: true
});
const repoName = path.basename(repoPath);
const outputPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  `../configs/${repoName}-profile.yaml`
);
await fs.writeFile(outputPath, output, 'utf8');

console.log(`✅ Generated ${path.resolve(outputPath)}`);
