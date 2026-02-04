/**
 * Proxy Traffic Metrics Collector
 *
 * Tracks and reports HTTP traffic routed through proxy
 * for visibility into pentest coverage.
 */

import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

/**
 * Proxy metrics storage
 */
class ProxyMetrics {
  constructor() {
    this.reset();
  }

  reset() {
    this.startTime = Date.now();
    this.requestCount = 0;
    this.toolCalls = {
      playwright: 0,
      bash_curl: 0,
      other: 0
    };
    this.uniqueHosts = new Set();
    this.httpMethods = {};
    this.statusCodes = {};
  }

  /**
   * Record a tool call that may generate HTTP traffic
   */
  recordToolCall(toolName) {
    if (toolName.includes('playwright') || toolName.includes('browser')) {
      this.toolCalls.playwright++;
    } else if (toolName === 'bash' || toolName === 'Bash') {
      // We can't know if it's curl without parsing, so we track all bash calls
      this.toolCalls.bash_curl++;
    } else {
      this.toolCalls.other++;
    }
  }

  /**
   * Record HTTP traffic metadata
   */
  recordRequest(metadata) {
    this.requestCount++;

    if (metadata.host) {
      this.uniqueHosts.add(metadata.host);
    }

    if (metadata.method) {
      this.httpMethods[metadata.method] = (this.httpMethods[metadata.method] || 0) + 1;
    }

    if (metadata.status) {
      const statusClass = `${Math.floor(metadata.status / 100)}xx`;
      this.statusCodes[statusClass] = (this.statusCodes[statusClass] || 0) + 1;
    }
  }

  /**
   * Get summary statistics
   */
  getSummary() {
    const duration = Date.now() - this.startTime;
    return {
      duration_ms: duration,
      total_tool_calls: Object.values(this.toolCalls).reduce((a, b) => a + b, 0),
      tool_breakdown: this.toolCalls,
      http_requests: this.requestCount,
      unique_hosts: this.uniqueHosts.size,
      http_methods: this.httpMethods,
      status_codes: this.statusCodes
    };
  }

  /**
   * Print summary to console
   */
  printSummary(agentName = 'Agent') {
    const summary = this.getSummary();
    const duration = (summary.duration_ms / 1000).toFixed(1);

    console.log(chalk.blue(`\n📊 Proxy Traffic Summary (${agentName})`));
    console.log(chalk.gray('━'.repeat(60)));

    console.log(chalk.cyan(`  ⏱️  Duration: ${duration}s`));
    console.log(chalk.cyan(`  🔧 Tool Calls: ${summary.total_tool_calls}`));


    if (summary.tool_breakdown.playwright > 0) {
      console.log(chalk.green(`     └─ Playwright: ${summary.tool_breakdown.playwright}`));
    }
    if (summary.tool_breakdown.bash_curl > 0) {
      console.log(chalk.yellow(`     └─ Bash (potential curl): ${summary.tool_breakdown.bash_curl}`));
    }

    console.log(chalk.cyan(`  🌐 HTTP Requests: ${summary.http_requests}`));
    console.log(chalk.cyan(`  🏠 Unique Hosts: ${summary.unique_hosts}`));

    if (Object.keys(summary.http_methods).length > 0) {
      console.log(chalk.gray(`  📝 Methods: ${JSON.stringify(summary.http_methods)}`));
    }

    if (Object.keys(summary.status_codes).length > 0) {
      console.log(chalk.gray(`  📊 Status Codes: ${JSON.stringify(summary.status_codes)}`));
    }

    console.log(chalk.gray('━'.repeat(60)));

    // Warning if no traffic detected
    if (summary.total_tool_calls === 0 && summary.http_requests === 0) {
      console.log(chalk.yellow('  ⚠️  No proxy traffic detected'));
    }
  }

  /**
   * Save metrics to audit log
   */
  async saveToAuditLog(auditLogDir, agentName) {
    const summary = this.getSummary();
    const metricsFile = path.join(auditLogDir, 'agents', `${agentName}_proxy_metrics.json`);

    try {
      const metricsDir = path.dirname(metricsFile);
      if (!fs.existsSync(metricsDir)) {
        fs.mkdirSync(metricsDir, { recursive: true });
      }

      fs.writeFileSync(metricsFile, JSON.stringify({
        agent: agentName,
        timestamp: new Date().toISOString(),
        metrics: summary
      }, null, 2));

      console.log(chalk.gray(`  💾 Metrics saved: ${path.basename(metricsFile)}`));
    } catch (error) {
      console.error(chalk.red(`  ❌ Failed to save metrics: ${error.message}`));
    }
  }
}

// Global singleton instance
export const proxyMetrics = new ProxyMetrics();

/**
 * Middleware to track tool calls
 */
export function trackToolCall(toolName) {
  proxyMetrics.recordToolCall(toolName);
}



/**
 * Helper: Extract host from HTTP request
 */
function extractHost(request) {
  if (!request) return null;
  const hostMatch = request.match(/Host:\s*([^\r\n]+)/i);
  return hostMatch ? hostMatch[1].trim() : null;
}

/**
 * Helper: Extract method from HTTP request
 */
function extractMethod(request) {
  if (!request) return null;
  const methodMatch = request.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)/);
  return methodMatch ? methodMatch[1] : null;
}

/**
 * Helper: Extract status code from HTTP response
 */
function extractStatus(response) {
  if (!response) return null;
  const statusMatch = response.match(/HTTP\/[\d.]+\s+(\d{3})/);
  return statusMatch ? parseInt(statusMatch[1]) : null;
}

/**
 * Reset metrics (call at start of each agent)
 */
export function resetProxyMetrics() {
  proxyMetrics.reset();
}

/**
 * Get current metrics summary
 */
export function getProxyMetricsSummary() {
  return proxyMetrics.getSummary();
}

/**
 * Print metrics summary
 */
export function printProxyMetrics(agentName) {
  proxyMetrics.printSummary(agentName);
}

/**
 * Save metrics to audit log
 */
export async function saveProxyMetrics(auditLogDir, agentName) {
  await proxyMetrics.saveToAuditLog(auditLogDir, agentName);
}
