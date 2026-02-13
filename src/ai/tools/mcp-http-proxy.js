import chalk from 'chalk';
import fetch from 'node-fetch';

/**
 * HTTP/SSE-based MCP Client for remote servers
 * Implements MCP protocol over HTTP with Server-Sent Events
 */
export class McpHttpProxy {
  constructor(name, url) {
    this.name = name;
    this.url = url.replace(/\/$/, ''); // Remove trailing slash
    this.requestId = 0;
    this.isInitialized = false;
    this.initializationPromise = null;
  }

  async ensureStarted() {
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = this._start();
    return this.initializationPromise;
  }

  async _start() {
    console.log(chalk.blue(`    🌐 Connecting to HTTP MCP server: ${this.name}`));
    console.log(chalk.gray(`       URL: ${this.url}`));

    try {
      // Test connection with a simple health check or initialize
      const initResult = await this.call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dokodemodoor-http-client', version: '1.0.0' }
      });

      this.isInitialized = true;
      console.log(chalk.green(`    ✅ HTTP MCP server ${this.name} initialized`));
      return initResult;
    } catch (e) {
      console.error(chalk.red(`    ❌ HTTP MCP initialization failed: ${e.message}`));
      this.initializationPromise = null;
      throw e;
    }
  }

  async call(method, params) {
    const id = String(++this.requestId);
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    if (process.env.DEBUG_MCP) {
      console.log(chalk.gray(`       [${this.name} HTTP OUT] ${JSON.stringify(request)}`));
    }

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(request),
        timeout: 60000 // 60 second timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();

      if (process.env.DEBUG_MCP) {
        console.log(chalk.gray(`       [${this.name} HTTP IN] ${JSON.stringify(result)}`));
      }

      if (result.error) {
        throw new Error(result.error.message || 'MCP Error');
      }

      return result.result;
    } catch (e) {
      console.error(chalk.red(`    ❌ HTTP MCP call failed for ${this.name}.${method}: ${e.message}`));
      throw e;
    }
  }

  async listTools() {
    await this.ensureStarted();
    const result = await this.call('tools/list', {});
    return result.tools || [];
  }

  async callTool(name, args) {
    await this.ensureStarted();
    const result = await this.call('tools/call', {
      name,
      arguments: args
    });
    return result;
  }

  stop() {
    // HTTP connections don't need explicit cleanup
    this.isInitialized = false;
    this.initializationPromise = null;
  }
}

// Singleton manager for HTTP MCP proxies
class McpHttpManager {
  constructor() {
    this.proxies = new Map();
  }

  getProxy(name, url) {
    if (!this.proxies.has(name)) {
      this.proxies.set(name, new McpHttpProxy(name, url));
    }
    return this.proxies.get(name);
  }

  stopAll() {
    for (const proxy of this.proxies.values()) {
      proxy.stop();
    }
    this.proxies.clear();
  }
}

export const mcpHttpManager = new McpHttpManager();
