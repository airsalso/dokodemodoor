import { spawn } from 'child_process';
import readline from 'readline';
import chalk from 'chalk';

/**
 * Minimal MCP Client for stdio-based servers
 */
export class McpProxy {
  constructor(name, command, args, env = {}, cwd = null) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = { ...process.env, ...env };
    this.cwd = cwd;
    this.process = null;
    this.rl = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.isInitialized = false;
    this.initializationPromise = null;
  }

  async ensureStarted() {
    // Only return existing promise if it exists AND the process is still alive
    if (this.initializationPromise && this.process) return this.initializationPromise;

    this.initializationPromise = this._start();
    return this.initializationPromise;
  }

  async _start() {
    console.log(chalk.blue(`    🏗️  Starting MCP server proxy: ${this.name}`));
    console.log(chalk.gray(`       Command: ${this.command} ${this.args.join(' ')}`));

    this.process = spawn(this.command, this.args, {
      env: this.env,
      cwd: this.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'] // Capture stderr too
    });

    this.rl = readline.createInterface({
      input: this.process.stdout,
      terminal: false
    });

    this.process.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(chalk.gray(`       [${this.name} stderr] ${msg}`));
    });

    this.rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const response = JSON.parse(line);
        // Log deep debug if enabled
        if (process.env.DEBUG_MCP) {
          console.log(chalk.gray(`       [${this.name} IN] ${line}`));
        }

        if (response.id !== undefined) {
          const handler = this.pendingRequests.get(String(response.id));
          if (handler) {
            this.pendingRequests.delete(String(response.id));
            if (response.error) {
              handler.reject(new Error(response.error.message || 'MCP Error'));
            } else {
              handler.resolve(response.result);
            }
          }
        }
      } catch (e) {
        // Some servers might output non-JSON text on stdout, which is bad practice but happens
        console.log(chalk.gray(`       [${this.name} stdout] ${line}`));
      }
    });

    this.process.on('error', (err) => {
      console.error(chalk.red(`    ❌ MCP server ${this.name} error: ${err.message}`));
    });

    this.process.on('exit', (code) => {
      console.log(chalk.yellow(`    ⚠️  MCP server ${this.name} exited with code ${code}`));
      this.process = null;
      this.isInitialized = false;
      this.initializationPromise = null;

      // Reject all pending requests
      for (const [id, handler] of this.pendingRequests.entries()) {
        handler.reject(new Error(`MCP server ${this.name} exited unexpectedly with code ${code}`));
      }
      this.pendingRequests.clear();

      if (this.rl) {
        try { this.rl.close(); } catch (e) {}
        this.rl = null;
      }
    });

    // Initialize MCP (Protocol version handshake)
    try {
      // 60 second timeout for initialization
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`MCP initialization timed out after 60s for ${this.name}`)), 60000);
      });

      console.log(chalk.blue(`    🔗 Connecting local client to remote MCP server: ${this.name}`));

      await Promise.race([
        this.call('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'dokodemodoor-vllm-proxy', version: '1.0.0' }
        }),
        timeoutPromise
      ]);

      // 'notifications/initialized' MUST be a notification (no ID)
      this.notify('notifications/initialized', {});

      this.isInitialized = true;
      console.log(chalk.green(`    ✅ MCP server ${this.name} initialized and mapped`));
    } catch (e) {
      console.error(chalk.red(`    ❌ MCP initialization failed: ${e.message}`));
      this.initializationPromise = null;
      if (this.process) this.process.kill();
      throw e;
    }
  }

  notify(method, params) {
    if (!this.process) return;
    const notification = {
      jsonrpc: '2.0',
      method,
      params
    };
    if (process.env.DEBUG_MCP) {
      console.log(chalk.gray(`       [${this.name} OUT/NOTIFY] ${JSON.stringify(notification)}`));
    }
    this.process.stdin.write(JSON.stringify(notification) + '\n');
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
      console.log(chalk.gray(`       [${this.name} OUT/CALL] ${JSON.stringify(request)}`));
    }

    // Capture stack for better error reporting
    const stack = new Error().stack;

    return new Promise((resolve, reject) => {
      // 300 second timeout for general calls (unless it's initialize which has its own 60s wrapper)
      let timeoutId = null;
      if (method !== 'initialize') {
        timeoutId = setTimeout(() => {
          this.pendingRequests.delete(id);
          const err = new Error(`MCP call '${method}' to ${this.name} timed out after 60s`);
          err.stack = stack;
          reject(err);
        }, 60000);
      }

      this.pendingRequests.set(id, {
        resolve: (val) => {
          if (timeoutId) clearTimeout(timeoutId);
          resolve(val);
        },
        reject: (err) => {
          if (timeoutId) clearTimeout(timeoutId);
          err.stack = stack;
          reject(err);
        }
      });

      // Ensure started but don't recursive call if we are already in _start()'s initialize
      if (method === 'initialize') {
        if (!this.process) {
           reject(new Error('Process not found during initialize'));
           return;
        }
        this.process.stdin.write(JSON.stringify(request) + '\n');
      } else {
        this.ensureStarted().then(() => {
          if (this.process) {
            this.process.stdin.write(JSON.stringify(request) + '\n');
          } else {
            reject(new Error(`MCP server ${this.name} is not running`));
          }
        }).catch(reject);
      }
    });
  }

  async listTools() {
    const result = await this.call('tools/list', {});
    return result.tools || [];
  }

  async callTool(name, args) {
    const result = await this.call('tools/call', {
      name,
      arguments: args
    });
    return result;
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}

// Singleton manager for MCP proxies
class McpManager {
  constructor() {
    this.proxies = new Map();
  }

  getProxy(name, command, args, env, cwd = null) {
    if (!this.proxies.has(name)) {
      this.proxies.set(name, new McpProxy(name, command, args, env, cwd));
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

export const mcpManager = new McpManager();
