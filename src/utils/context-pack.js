import { fs, path } from 'zx';

/**
 * Context Pack utilities.
 *
 * Goal:
 * - Avoid injecting full recon/recon-verify/api-fuzzer deliverables into every specialist prompt
 * - Prefer small, structured "context packs" under deliverables/_context/
 * - Provide safe fallbacks by extracting only relevant sections (bounded) when packs are missing
 */

const DEFAULTS = Object.freeze({
  maxTargets: 25,
  maxHotspots: 15,
  maxExcerptChars: 2500,
  maxContextChars: 9000,
  maxExistingFindings: 20
});

export const getContextPackPaths = (sourceDir) => {
  const deliverablesDir = path.join(sourceDir, 'deliverables');
  const contextDir = path.join(deliverablesDir, '_context');
  return Object.freeze({
    deliverablesDir,
    contextDir,
    globalMd: path.join(contextDir, 'global.md'),
    reconVerifyTargetsJson: path.join(contextDir, 'recon_verify_targets.json'),
    apiFuzzerHotspotsJson: path.join(contextDir, 'api_fuzzer_hotspots.json'),
    reconVerifyMd: path.join(deliverablesDir, 'recon_verify_deliverable.md'),
    reconMd: path.join(deliverablesDir, 'recon_deliverable.md'),
    apiFuzzerMd: path.join(deliverablesDir, 'api_fuzzer_deliverable.md'),
    authSessionJson: path.join(deliverablesDir, 'auth_session.json')
  });
};

const safeReadJson = async (filePath) => {
  try {
    if (!await fs.pathExists(filePath)) return null;
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const truncate = (text, maxChars) => {
  if (!text || typeof text !== 'string') return '';
  if (!maxChars || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 80))}\n\n...[TRUNCATED ${text.length} chars → ${maxChars} chars]`;
};

const normalizeCategory = (category) => String(category || '').toUpperCase().trim();

const globToRegex = (pattern) => {
  const escaped = String(pattern || '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.replace(/\*/g, '.*'), 'i');
};

const safeToString = (v) => (v === null || v === undefined) ? '' : String(v);

const extractHostAndPath = (value) => {
  const raw = safeToString(value).trim();
  if (!raw) return { host: '', path: '' };
  try {
    const u = new URL(raw);
    return { host: u.hostname || '', path: `${u.pathname || ''}${u.search || ''}` };
  } catch {
    // Likely a relative path like "/api/.."
    return { host: '', path: raw };
  }
};

const stringMatchesRule = (value, rule) => {
  if (!value || !rule?.url_path) return false;
  const hay = safeToString(value).toLowerCase();
  const needle = safeToString(rule.url_path).toLowerCase();

  switch (rule.type) {
    case 'path': {
      if (needle.includes('*')) return globToRegex(rule.url_path).test(value);
      return hay.includes(needle);
    }
    case 'subdomain':
    case 'domain':
      return hay.includes(needle);
    default:
      return false;
  }
};

const itemMatchesAvoidRules = (item, avoidRules) => {
  if (!item || !Array.isArray(avoidRules) || avoidRules.length === 0) return false;

  const method = safeToString(item.method || item.http_method || item.verb).toUpperCase();
  const rawPath = safeToString(item.path || item.url_path || item.endpoint || item.url || item.source_endpoint);
  const rawParam = safeToString(item.param || item.parameter || item.vulnerable_parameter);

  const { host, path: parsedPath } = extractHostAndPath(rawPath);

  return avoidRules.some((rule) => {
    if (!rule?.type) return false;
    switch (rule.type) {
      case 'method':
        return method && safeToString(rule.url_path).toUpperCase() === method;
      case 'parameter':
        return rawParam && safeToString(rule.url_path).toLowerCase() === rawParam.toLowerCase();
      case 'path':
        return stringMatchesRule(parsedPath || rawPath, rule);
      case 'subdomain':
      case 'domain':
        // Only meaningful when we have a host present (full URL).
        return host ? stringMatchesRule(host, rule) : stringMatchesRule(rawPath, rule);
      default:
        return false;
    }
  });
};

const filterMarkdownExcerptByAvoid = (markdown, avoidRules) => {
  if (!markdown || !Array.isArray(avoidRules) || avoidRules.length === 0) return markdown;

  // For free-form markdown, only apply string-based rules that are low-risk (path/domain).
  const safeRules = avoidRules.filter(r => ['path', 'subdomain', 'domain'].includes(r?.type));
  if (safeRules.length === 0) return markdown;

  const lines = markdown.split('\n');
  const filtered = lines.filter((line) => {
    if (!line.trim()) return true;
    if (line.startsWith('## [CATEGORY:')) return true;
    return !safeRules.some((rule) => stringMatchesRule(line, rule));
  });

  return filtered.join('\n');
};

export const agentNameToCategory = (agentName) => {
  const name = String(agentName || '');
  const base = name.replace(/-(vuln|exploit)$/, '');
  const map = {
    sqli: 'SQLI',
    codei: 'CODEI',
    ssti: 'SSTI',
    pathi: 'PATHI',
    xss: 'XSS',
    auth: 'AUTH',
    authz: 'AUTHZ',
    ssrf: 'SSRF'
  };
  return map[base] || null;
};

const renderTarget = (t) => {
  if (!t || typeof t !== 'object') return null;
  const method = t.method || t.http_method || t.verb || '';
  const p = t.path || t.url_path || t.endpoint || t.url || t.source_endpoint || '';
  const param = t.param || t.parameter || t.vulnerable_parameter || '';
  const file = t.file || t.path_in_repo || t.code_file || t.source_file || t.vulnerable_code_location || '';
  const line = t.line || t.line_number || '';
  const why = t.why || t.summary || t.evidence || t.reason || '';
  const confidence = t.confidence || t.confidence_level || '';

  const main = `${method ? method.toUpperCase() + ' ' : ''}${p}`.trim();
  const loc = [file, line].filter(Boolean).join(':');
  const parts = [];
  if (main) parts.push(`- ${main}`);
  if (param) parts.push(`  - Param: \`${param}\``);
  if (loc) parts.push(`  - Code: \`${loc}\``);
  if (confidence) parts.push(`  - Confidence: ${confidence}`);
  if (why) parts.push(`  - Why: ${String(why).slice(0, 240)}`);
  return parts.join('\n');
};

export const summarizeReconVerifyTargets = async (sourceDir, category, { maxTargets = DEFAULTS.maxTargets, avoidRules = [] } = {}) => {
  const paths = getContextPackPaths(sourceDir);
  const data = await safeReadJson(paths.reconVerifyTargetsJson);
  if (!data) return null;

  const cat = normalizeCategory(category);
  let items = [];

  // Accept either { targets: { SQLI: [...] } } or { targets: [ { category: "SQLI", ... } ] }.
  if (data.targets && typeof data.targets === 'object' && !Array.isArray(data.targets)) {
    const fromMap = data.targets[cat];
    if (Array.isArray(fromMap)) items = fromMap;
  } else if (Array.isArray(data.targets)) {
    items = data.targets.filter(t => normalizeCategory(t.category || t.vulnerability_type || t.type) === cat);
  } else if (Array.isArray(data[cat])) {
    items = data[cat];
  }

  if (!Array.isArray(items) || items.length === 0) return null;
  const filteredItems = items.filter((t) => !itemMatchesAvoidRules(t, avoidRules));
  if (filteredItems.length === 0) return null;

  const rendered = filteredItems
    .slice(0, maxTargets)
    .map(renderTarget)
    .filter(Boolean)
    .join('\n');

  return rendered ? `## VERIFIED TARGETS (Context Pack)\n${rendered}\n` : null;
};

export const summarizeApiFuzzerHotspots = async (sourceDir, category, { maxHotspots = DEFAULTS.maxHotspots, avoidRules = [] } = {}) => {
  const paths = getContextPackPaths(sourceDir);
  const data = await safeReadJson(paths.apiFuzzerHotspotsJson);
  if (!data) return null;

  const cat = normalizeCategory(category);
  let items = [];

  if (Array.isArray(data.hotspots)) {
    items = data.hotspots;
  } else if (Array.isArray(data.items)) {
    items = data.items;
  } else if (Array.isArray(data)) {
    items = data;
  }

  if (!Array.isArray(items) || items.length === 0) return null;
  const avoidFiltered = items.filter((h) => !itemMatchesAvoidRules(h, avoidRules));
  if (avoidFiltered.length === 0) return null;

  // Best-effort filtering: if no tags/categories exist, keep top items.
  const filtered = avoidFiltered.filter(h => {
    const cats = h.categories || h.category || h.tags || h.vulnerability_categories;
    if (!cats) return true;
    const list = Array.isArray(cats) ? cats : String(cats).split(',').map(s => s.trim());
    return list.map(normalizeCategory).includes(cat);
  });

  const picked = (filtered.length > 0 ? filtered : items).slice(0, maxHotspots);
  const rendered = picked.map((h) => {
    const method = h.method || h.http_method || '';
    const p = h.path || h.url_path || h.endpoint || h.url || '';
    const signal = h.signal || h.classification || h.type || h.status || '';
    const file = h.file || h.vulnerable_code_location || '';
    const line = h.line || '';
    const summary = h.summary || h.observation || h.notes || '';
    const loc = [file, line].filter(Boolean).join(':');
    const head = `${method ? method.toUpperCase() + ' ' : ''}${p}`.trim();
    const parts = [];
    if (head) parts.push(`- ${head}`);
    if (signal) parts.push(`  - Signal: ${String(signal).slice(0, 60)}`);
    if (loc) parts.push(`  - Code: \`${loc}\``);
    if (summary) parts.push(`  - Note: ${String(summary).slice(0, 240)}`);
    return parts.join('\n');
  }).filter(Boolean).join('\n');

  return rendered ? `## API FUZZ HOTSPOTS (Context Pack)\n${rendered}\n` : null;
};

export const extractCategorySectionFromReconVerify = (content, category, { maxChars = DEFAULTS.maxExcerptChars } = {}) => {
  const cat = normalizeCategory(category);
  const header = `## [CATEGORY: ${cat}]`;
  const idx = content.indexOf(header);
  if (idx === -1) return null;

  const after = content.slice(idx);
  const nextIdx = after.slice(header.length).search(/\n## \[CATEGORY:\s*[A-Z]+\]/);
  const section = nextIdx === -1 ? after : after.slice(0, header.length + nextIdx);
  return truncate(section.trim(), maxChars);
};

export const loadReconVerifyExcerptFallback = async (sourceDir, category, { maxChars = DEFAULTS.maxExcerptChars, avoidRules = [] } = {}) => {
  const paths = getContextPackPaths(sourceDir);
  if (!await fs.pathExists(paths.reconVerifyMd)) return null;
  try {
    const content = await fs.readFile(paths.reconVerifyMd, 'utf8');
    const sec = extractCategorySectionFromReconVerify(content, category, { maxChars });
    if (!sec) return null;
    const filtered = filterMarkdownExcerptByAvoid(sec, avoidRules);
    const final = truncate(filtered.trim(), maxChars);
    if (!final) return null;
    return `## VERIFIED TARGETS (Fallback Excerpt: recon_verify_deliverable.md)\n${final}\n`;
  } catch {
    return null;
  }
};

export const summarizeAuthSessionAvailable = async (sourceDir) => {
  const paths = getContextPackPaths(sourceDir);
  if (!await fs.pathExists(paths.authSessionJson)) return null;
  try {
    const raw = await fs.readFile(paths.authSessionJson, 'utf8');
    const data = JSON.parse(raw);
    const keys = Object.keys(data || {});
    const cookieKeys = [];
    const headerKeys = [];

    // Heuristics only: do not include raw token values in injected context.
    if (data && typeof data === 'object') {
      if (data.cookies && typeof data.cookies === 'object') cookieKeys.push(...Object.keys(data.cookies));
      if (data.headers && typeof data.headers === 'object') headerKeys.push(...Object.keys(data.headers));
      if (data.cookie && typeof data.cookie === 'string') cookieKeys.push('cookie');
      if (data.authorization && typeof data.authorization === 'string') headerKeys.push('authorization');
    }

    const lines = [];
    lines.push('## AUTH SESSION (Available On Disk)');
    lines.push(`- Path: \`deliverables/auth_session.json\``);
    if (headerKeys.length > 0) lines.push(`- Header keys: ${headerKeys.slice(0, 12).map(k => `\`${k}\``).join(', ')}`);
    if (cookieKeys.length > 0) lines.push(`- Cookie keys: ${cookieKeys.slice(0, 12).map(k => `\`${k}\``).join(', ')}`);
    if (keys.length > 0) lines.push(`- Fields: ${keys.slice(0, 12).map(k => `\`${k}\``).join(', ')}`);
    lines.push('- Instruction: Use `open_file` to read and copy exact tokens/values only when executing requests.');
    return lines.join('\n') + '\n';
  } catch {
    return '## AUTH SESSION (Available On Disk)\n- Path: `deliverables/auth_session.json`\n- Instruction: Use `open_file` to read it when needed.\n';
  }
};

export const summarizeExistingFindingsForCumulativeMode = (queueData, { maxItems = DEFAULTS.maxExistingFindings } = {}) => {
  const vulns = Array.isArray(queueData?.vulnerabilities) ? queueData.vulnerabilities : [];
  if (vulns.length === 0) return null;

  const slim = vulns.slice(0, maxItems).map((v, idx) => ({
    n: idx + 1,
    id: v.ID || v.vulnerability_id || v.id || null,
    type: v.vulnerability_type || v.type || null,
    severity: v.severity || null,
    source: v.source || v.source_endpoint || v.endpoint || v.url_path || null,
    param: v.vulnerable_parameter || v.parameter || v.param || null
  }));

  const body = JSON.stringify({ count: vulns.length, preview: slim }, null, 2);
  return `## EXISTING FINDINGS (Cumulative Analysis Mode)\n` +
    `Existing queue has **${vulns.length}** item(s). Preview (first ${Math.min(maxItems, vulns.length)}):\n` +
    `\`\`\`json\n${body}\n\`\`\`\n` +
    `**MISSION**: Do NOT duplicate these. Discover NEW items and merge with existing when saving.\n`;
};

export const assembleTargetedContext = async (sourceDir, agentName, distributedConfig = null, opts = {}) => {
  const category = agentNameToCategory(agentName);
  if (!category) return '';

  const options = { ...DEFAULTS, ...opts };
  const avoidRules = distributedConfig?.avoid || [];
  const parts = [];

  // Prefer context packs first.
  const targets = await summarizeReconVerifyTargets(sourceDir, category, { maxTargets: options.maxTargets, avoidRules });
  if (targets) parts.push(targets);

  const hotspots = await summarizeApiFuzzerHotspots(sourceDir, category, { maxHotspots: options.maxHotspots, avoidRules });
  if (hotspots) parts.push(hotspots);

  // Auth session: pointer only (no secrets).
  const auth = await summarizeAuthSessionAvailable(sourceDir);
  if (auth) parts.push(auth);

  // Fallback excerpt if packs are missing.
  if (!targets) {
    const fallback = await loadReconVerifyExcerptFallback(sourceDir, category, { maxChars: options.maxExcerptChars, avoidRules });
    if (fallback) parts.push(fallback);
  }

  // Always provide a strict retrieval rule to prevent full-file paste loops.
  parts.push(
    `## PROGRESSIVE RETRIEVAL RULES (MANDATORY)\n` +
    `- Start with the Context Pack sections above.\n` +
    `- If you need more details, do NOT read full recon files. Use \`search_file\` first, then \`open_file\` only the relevant section.\n` +
    `- Avoid re-reading large deliverables unless absolutely necessary.\n`
  );

  const joined = parts.filter(Boolean).join('\n');
  return truncate(joined, options.maxContextChars);
};
