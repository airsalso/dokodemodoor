import { $ } from 'zx';
import fs from 'fs/promises';

const OFFLINE_FLAG_SETS = [
  { offline: '--offline', download: '--download-offline-databases' },
  { offline: '--experimental-offline', download: '--experimental-download-offline-databases' }
];

function isUnknownFlagError(error) {
  const message = `${error?.stderr || ''} ${error?.stdout || ''} ${error?.message || ''}`.toLowerCase();
  return message.includes('unknown flag') || message.includes('flag provided but not defined');
}

function resolveDbDir() {
  return process.env.DOKODEMODOOR_OSV_DB_DIR || process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY || null;
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveOsvScannerCmd() {
  const explicit = process.env.DOKODEMODOOR_OSV_SCANNER_PATH;
  if (explicit && await pathExists(explicit)) {
    return explicit;
  }

  try {
    const result = await $`command -v osv-scanner`;
    const resolved = (result.stdout || '').trim();
    if (resolved) return resolved;
  } catch {}

  if (await pathExists('/snap/bin/osv-scanner')) {
    return '/snap/bin/osv-scanner';
  }

  return null;
}

async function ensureOsvScannerAvailable() {
  const cmd = await resolveOsvScannerCmd();
  if (!cmd) {
    throw new Error('osv-scanner not found in PATH');
  }
  return cmd;
}

async function runOsvScannerWithFlags(sourceDir, flags, options) {
  const { downloadDb, useLegacyCli, scannerCmd } = options;
  const env = { ...process.env };
  const dbDir = resolveDbDir();
  if (dbDir) {
    env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY = dbDir;
  }

  const extraFlags = [];
  if (downloadDb) extraFlags.push(flags.download);

  try {
    if (useLegacyCli) {
      return await $({ quiet: true, env })`${scannerCmd} --format json ${flags.offline} ${extraFlags} -r ${sourceDir}`;
    }
    return await $({ quiet: true, env })`${scannerCmd} scan source --format json ${flags.offline} ${extraFlags} -r ${sourceDir}`;
  } catch (error) {
    if (error?.stdout) return error;
    throw error;
  }
}

export async function scanOsvOffline(sourceDir, options = {}) {
  const { downloadDb = false } = options;
  const scannerCmd = await ensureOsvScannerAvailable();

  let lastError;
  for (const flags of OFFLINE_FLAG_SETS) {
    try {
      const result = await runOsvScannerWithFlags(sourceDir, flags, { downloadDb, useLegacyCli: false, scannerCmd });
      const raw = (result.stdout || '').trim();
      if (!raw) return { raw: '', data: { results: [] }, findings: [] };
      const data = parseOsvJson(raw);
      const findings = normalizeOsvFindings(data);
      return { raw, data, findings };
    } catch (error) {
      if (isUnknownSubcommandError(error)) {
        lastError = error;
      } else if (isUnknownFlagError(error)) {
        lastError = error;
        continue;
      } else {
        lastError = error;
        break;
      }
    }
    try {
      const result = await runOsvScannerWithFlags(sourceDir, flags, { downloadDb, useLegacyCli: true, scannerCmd });
      const raw = (result.stdout || '').trim();
      if (!raw) return { raw: '', data: { results: [] }, findings: [] };
      const data = parseOsvJson(raw);
      const findings = normalizeOsvFindings(data);
      return { raw, data, findings };
    } catch (error) {
      lastError = error;
      if (!isUnknownFlagError(error)) break;
    }
  }

  throw lastError;
}

function isUnknownSubcommandError(error) {
  const message = `${error?.stderr || ''} ${error?.stdout || ''} ${error?.message || ''}`.toLowerCase();
  return message.includes('unknown command') || message.includes('unknown subcommand');
}

export function normalizeOsvFindings(data) {
  const findings = [];
  const results = data?.results || [];

  for (const result of results) {
    const packages = result?.packages || [];
    for (const pkg of packages) {
      const vulnerabilities = pkg?.vulnerabilities || [];
      if (vulnerabilities.length === 0) continue;

      const pkgInfo = pkg.package || {};
      const packageName = pkgInfo.name || 'unknown';
      const packageVersion = pkgInfo.version || 'unknown';
      const ecosystem = pkgInfo.ecosystem || 'unknown';

      findings.push({
        package: packageName,
        version: packageVersion,
        ecosystem,
        vulnerabilities: vulnerabilities.map(vuln => ({
          id: vuln.id,
          summary: vuln.summary || (vuln.details ? vuln.details.split('\n')[0] : ''),
          details: vuln.details,
          published: vuln.published
        }))
      });
    }
  }

  return findings;
}

function parseOsvJson(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { results: [] };

  try {
    return JSON.parse(trimmed);
  } catch {}

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = trimmed.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  const snippet = trimmed.slice(0, 200).replace(/\s+/g, ' ');
  throw new Error(`OSV output is not valid JSON. First output: ${snippet}`);
}
