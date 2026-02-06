/**
 * Tool Registry
 *
 * Manages tool definitions and conversions between formats:
 * - SDK tool format (using tool() function)
 * - OpenAI function calling format
 */

import { z } from 'zod';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { mcpManager } from './mcp-proxy.js';
import { getTargetDir } from '../../utils/context.js';

// Initialize Ajv for remote tool validation
// Support Draft 2020-12 and better flexibility for MCP/LLM schemas
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  strictTypes: false,
  allowUnionTypes: true
});
addFormats(ajv);

/**
 * [목적] Zod 스키마를 OpenAI JSON Schema 형식으로 변환.
 *
 * [호출자]
 * - ToolRegistry.getOpenAITools()
 *
 * [출력 대상]
 * - JSON Schema 객체 반환
 */
export function zodToJsonSchema(zodSchema) {
  // If it's already a JSON schema or has our marker, return it directly
  if (zodSchema && (zodSchema.__isJsonSchema || !zodSchema._def)) {
    return zodSchema;
  }
  // This is a simplified converter
  const shape = zodSchema._def.shape ? zodSchema._def.shape() : zodSchema.shape;

  const properties = {};
  const required = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = convertZodType(value);

    // Check if field is required
    if (!value.isOptional()) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined
  };
}

/**
 * [목적] 개별 Zod 타입을 JSON Schema 타입으로 변환.
 *
 * [호출자]
 * - zodToJsonSchema()
 *
 * [출력 대상]
 * - JSON Schema 타입 객체 반환
 */
function convertZodType(zodType) {
  const typeName = zodType._def.typeName;

  switch (typeName) {
    case 'ZodString':
      return {
        type: 'string',
        description: zodType.description
      };
    case 'ZodNumber':
      return {
        type: 'number',
        description: zodType.description
      };
    case 'ZodBoolean':
      return {
        type: 'boolean',
        description: zodType.description
      };
    case 'ZodEnum':
      return {
        type: 'string',
        enum: zodType._def.values,
        description: zodType.description
      };
    case 'ZodNativeEnum':
      return {
        type: 'string',
        enum: Object.values(zodType._def.values),
        description: zodType.description
      };
    case 'ZodArray':
      return {
        type: 'array',
        items: convertZodType(zodType._def.type),
        description: zodType.description
      };
    case 'ZodObject':
      return zodToJsonSchema(zodType);
    default:
      return {
        type: 'string',
        description: zodType.description || 'Unknown type'
      };
  }
}

/**
 * [목적] JSON Schema에서 지원하지 않거나 오류를 유발하는 키워드($schema 등)를 제거.
 *
 * [호출자]
 * - registerRemoteMCPTools()
 */
function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;

  // Clone the schema to avoid mutating the original tool definition
  const cleaned = Array.isArray(schema) ? [] : {};

  for (const [key, value] of Object.entries(schema)) {
    // Skip $schema as it often causes issues with both Ajv and LLM tool calling formats
    if (key === '$schema') continue;

    // Recursively clean objects and arrays
    if (value !== null && typeof value === 'object') {
      cleaned[key] = cleanSchema(value);
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
}

/**
 * Tool Registry Class
 * Stores and manages tool definitions
 */
export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  /**
   * Register a tool
   *
   * @param {string} name - Tool name
   * @param {string} description - Tool description
   * @param {Object} schema - Zod schema or JSON schema
   * @param {Function} handler - Tool handler function
   */
  register(name, description, schema, handler) {
    this.tools.set(name, {
      name,
      description,
      schema,
      handler
    });
  }

  /**
   * Get tool by name
   */
  getTool(name) {
    return this.tools.get(name);
  }

  /**
   * Get all tools
   */
  getAllTools() {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool definitions in OpenAI format
   */
  /**
   * [목적] 등록된 도구를 OpenAI function calling 스키마로 변환.
   *
   * [호출자]
   * - vLLM Provider (tool registry 조회)
   *
   * [출력 대상]
   * - OpenAI tools 배열 반환
   */
  getOpenAITools() {
    return Array.from(this.tools.values()).map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.schema)
      }
    }));
  }

  /**
   * Execute a tool by name
   */
  /**
   * [목적] 등록된 도구를 이름으로 실행.
   *
   * [호출자]
   * - tool-executor.js
   *
   * [출력 대상]
   * - 도구 실행 결과 반환
   *
   * [입력 파라미터]
   * - name (string)
   * - args (object)
   */
  async executeTool(name, args) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    // Validate arguments using Zod schema
    const validated = tool.schema.parse(args);

    // Execute handler
    return await tool.handler(validated);
  }
}

// Global tool registry instance
export const toolRegistry = new ToolRegistry();

/**
 * Register MCP tools from DokodemoDoor helper server
 */
/**
 * Register MCP tools from DokodemoDoor helper server
 */
/**
 * [목적] MCP 서버 기반 도구들을 레지스트리에 등록.
 *
 * [호출자]
 * - agent-executor.js (vLLM 사용 시)
 *
 * [출력 대상]
 * - toolRegistry에 MCP 도구 등록
 *
 * [반환값]
 * - Promise<void>
 */
export async function registerMCPTools() {
  // Import and register save_deliverable tool
  const saveDeliverableModule = await import('../../../mcp-server/src/tools/save-deliverable.js');
  const { SaveDeliverableInputSchema, saveDeliverable } = saveDeliverableModule;
  toolRegistry.register(
    'save_deliverable',
    'Saves deliverable files with automatic validation. Queue files must have {"vulnerabilities": [...]} structure.',
    SaveDeliverableInputSchema,
    saveDeliverable
  );

  // Import and register generate_totp tool
  const generateTotpModule = await import('../../../mcp-server/src/tools/generate-totp.js');
  const { GenerateTotpInputSchema, generateTotp } = generateTotpModule;
  toolRegistry.register(
    'generate_totp',
    'Generates 6-digit TOTP code for authentication. Secret must be base32-encoded.',
    GenerateTotpInputSchema,
    generateTotp
  );

  // Import and register TaskAgent tool
  const taskAgentModule = await import('../../../mcp-server/src/tools/task-agent.js');
  const {
    TaskAgentInputSchema, taskAgent,
    BashToolSchema, executeBash,
    TodoWriteSchema, executeTodoWrite
  } = taskAgentModule;

  toolRegistry.register(
    'TaskAgent',
    'Delegate a task to a specialized sub-agent. Use this to analyze source code, trace authentication mechanisms, or investigate specific security concerns.',
    TaskAgentInputSchema,
    taskAgent
  );

  toolRegistry.register(
    'bash',
    'Execute bash commands for file operations, code search (grep, find), and analysis.',
    BashToolSchema,
    executeBash
  );

  toolRegistry.register(
    'Bash',
    'Alias for bash tool',
    BashToolSchema,
    executeBash
  );

  toolRegistry.register(
    'TodoWrite',
    'Write or update your internal todo list to track progress.',
    TodoWriteSchema,
    executeTodoWrite
  );

  // Import and register HTTP Helper tools
  const httpHelpersModule = await import('../../../mcp-server/src/tools/http-helpers.js');
  const {
    BuildHttpRequestInputSchema, buildHttpRequest,
    CalculateContentLengthInputSchema, calculateContentLength,
    ParseHttpRequestInputSchema, parseHttpRequest
  } = httpHelpersModule;

  toolRegistry.register(
    'build_http_request',
    'Build a well-formed HTTP request with automatic Content-Length calculation. Use this before crafting manual HTTP requests.',
    BuildHttpRequestInputSchema,
    buildHttpRequest
  );

  toolRegistry.register(
    'calculate_content_length',
    'Calculate the exact byte length of an HTTP request body. Use when manually crafting requests.',
    CalculateContentLengthInputSchema,
    calculateContentLength
  );

  toolRegistry.register(
    'parse_http_request',
    'Parse a raw HTTP request into components (method, headers, body). Use to analyze captured HTTP requests.',
    ParseHttpRequestInputSchema,
    parseHttpRequest
  );

  // Common aliases for main agent as well
  const bashAliases = ['grep', 'search_file', 'open_file', 'read_file', 'ls', 'find', 'list_files', 'rg'];
  for (const alias of bashAliases) {
    toolRegistry.register(
      alias,
      `Alias for bash. Use this for ${alias} operations.`,
      z.object({
        command: z.string().optional(),
        path: z.string().optional(),
        query: z.string().optional(),
        line_start: z.coerce.number().optional(),
        line_end: z.coerce.number().optional(),
        max_results: z.coerce.number().optional()
      }),
      async (p) => {
        let cmd = p.command;

        // Cache rg availability for faster searches when possible
        if (typeof global.__DOKODEMODOOR_RG_AVAILABLE === 'undefined') {
          try {
            const { execSync } = await import('child_process');
            execSync('command -v rg', { stdio: 'ignore' });
            global.__DOKODEMODOOR_RG_AVAILABLE = true;
          } catch (e) {
            global.__DOKODEMODOOR_RG_AVAILABLE = false;
          }
        }

        // Helper to quote strings for shell
        const shQuote = (str) => {
          if (!str) return '""';
          return "'" + str.replace(/'/g, "'\\''") + "'";
        };

        // Path normalization: Safe guarding against LLM omitting leading slash on absolute paths.
        if (p.path) {
          const targetDir = getTargetDir();

          // Resolve relative paths against repo root
          if (!path.isAbsolute(p.path)) {
            const absCandidate = path.resolve(targetDir, p.path);
            if (fs.existsSync(absCandidate)) {
              p.path = absCandidate;
              console.log(chalk.gray(`      🔧 Auto-resolved path: ${p.path}`));
            }
          }

          // If still missing, attempt basename recovery via rg --files
          if (!fs.existsSync(p.path)) {
            try {
              const { execSync } = await import('child_process');
              const base = path.basename(p.path);
              const cmd = `rg --files -g '*${base}*' ${shQuote(targetDir)} | head -n 1`;
              const match = execSync(cmd, { encoding: 'utf8' }).trim();
              if (match) {
                p.path = match;
                console.log(chalk.gray(`      🔧 Auto-recovered path: ${p.path}`));
              }
            } catch (e) {
              // Best-effort fallback; keep original path if anything fails.
            }
          }

          // Legacy normalization for absolute-like paths missing leading slash
          if (!p.path.startsWith('/')) {
            const correctedPath = '/' + p.path;
            if (!fs.existsSync(p.path) && correctedPath.includes(targetDir)) {
              p.path = correctedPath;
              console.log(chalk.gray(`      🔧 Context-aware path normalization: ${p.path}`));
            }
          }
        }

        // If path looks like README.md but doesn't exist, try case-insensitive match in the same dir.
        if (p.path) {
          try {
            const base = path.basename(p.path);
            if (base.toLowerCase() === 'readme.md' && !fs.existsSync(p.path)) {
              const dir = path.dirname(p.path);
              const entries = fs.readdirSync(dir);
              const match = entries.find(name => name.toLowerCase() === 'readme.md');
              if (match) {
                p.path = path.join(dir, match);
              }
            }
          } catch (e) {
            // Best-effort fallback; keep original path if anything fails.
          }
        }

        // Logical mapping based on alias and provided parameters
        if (alias === 'open_file' || alias === 'read_file') {
          if (!cmd && p.path) {
            if (p.line_start !== undefined || p.line_end !== undefined) {
              const start = p.line_start || 1;
              const end = p.line_end || '$';

              cmd = `sed -n '${start},${end}p' ${shQuote(p.path)}`;
            } else {
              cmd = `cat ${shQuote(p.path)}`;
            }
          }
        } else if (alias === 'grep' || alias === 'search_file') {
          if (p.query) {
            const max = p.max_results || 100;
            const targetPath = p.path || '.';

            // Smart query: if multiple words are provided, create a regex that matches lines containing all of them
            // This is better than literal match for vulnerability hunting.
            let searchableQuery = p.query;
            const words = p.query.trim().split(/\s+/).filter(w => w.length > 0);
            if (words.length > 1) {
              // Regex pattern for AND logic: (?=.*word1)(?=.*word2)...
              searchableQuery = words.map(w => `(?=.*${w})`).join('') + '.*';
            }

            const excludes = [
              'node_modules', 'vendor', '.git', '.idea', '.vscode',
              'audit-logs*', 'deliverables*', 'reports',
              'dist', 'build', 'target', 'bin', 'obj', 'out',
              '__pycache__', 'venv', '.venv'
            ];
            const rgExcludes = excludes.map(e => `-g '!${e}'`).join(' ');
            const grepExcludes = excludes.map(e => `--exclude-dir=${shQuote(e)}`).join(' ');

            const regexMeta = /[()[\]{}.+*?^$|\\]/;
            const useFixed = regexMeta.test(p.query);

            if (global.__DOKODEMODOOR_RG_AVAILABLE) {
              if (useFixed) {
                cmd = `rg -n --no-heading --color never ${rgExcludes} -F ${shQuote(p.query)} ${shQuote(targetPath)} | head -n ${max}`;
              } else if (words.length > 1) {
                cmd = `rg -n --no-heading --color never ${rgExcludes} -P ${shQuote(searchableQuery)} ${shQuote(targetPath)} | head -n ${max}`;
              } else {
                cmd = `rg -n --no-heading --color never ${rgExcludes} ${shQuote(p.query)} ${shQuote(targetPath)} | head -n ${max}`;
              }
            } else {
              if (useFixed) {
                cmd = `grep -rn ${grepExcludes} -F -- ${shQuote(p.query)} ${shQuote(targetPath)} | head -n ${max}`;
              } else if (words.length > 1) {
                let grepChain = `grep -rn ${grepExcludes} -- . ${shQuote(targetPath)}`;
                for (const word of words) {
                  grepChain += ` | grep -i ${shQuote(word)}`;
                }
                cmd = `${grepChain} | head -n ${max}`;
              } else {
                cmd = `grep -rn ${grepExcludes} -- ${shQuote(p.query)} ${shQuote(targetPath)} | head -n ${max}`;
              }
            }
          }
        } else if (alias === 'ls' && (!cmd || cmd.startsWith('-'))) {
          const targetPath = p.path || '.';
          const flags = cmd || '';
          cmd = `ls -la ${flags} ${shQuote(targetPath)}`;
        } else if (alias === 'find' && (!cmd || cmd.startsWith('-'))) {
          const targetPath = p.path || '.';
          const flags = cmd || '';
          const nameFilter = p.query ? `-name ${shQuote(`*${p.query}*`)}` : '';
          cmd = `find ${shQuote(targetPath)} ${flags} ${nameFilter}`;
        } else if (alias === 'list_files' && (!cmd || cmd.startsWith('-'))) {
          const targetPath = p.path || '.';
          const flags = cmd || '';
          if (global.__DOKODEMODOOR_RG_AVAILABLE) {
            const globFilter = p.query ? `-g ${shQuote(`*${p.query}*`)}` : '';
            cmd = `rg ${flags} --files ${globFilter} ${shQuote(targetPath)}`;
          } else {
            const nameFilter = p.query ? `-name ${shQuote(`*${p.query}*`)}` : '';
            cmd = `find ${shQuote(targetPath)} ${flags} ${nameFilter}`;
          }
        }

        // Fallback to p.command if still empty
        if (!cmd) {
          if (p.command) {
            cmd = p.command;
          } else if (p.path) {
            // Check if path is a directory before using cat
            try {
              if (fs.existsSync(p.path) && fs.statSync(p.path).isDirectory()) {
                cmd = `ls -la ${shQuote(p.path)}`;
              } else {
                cmd = `cat ${shQuote(p.path)}`;
              }
            } catch (e) {
              cmd = `cat ${shQuote(p.path)}`;
            }
          } else if (p.query) {
            cmd = `grep -rn ${shQuote(p.query)} ${shQuote(p.path || '.')} | head -n 100`;
          }
        }

        // AUTO-FIX: If we have a path but the command (like sed, cat, head, tail) doesn't contain it, append it.
        // DO NOT auto-fix if command contains a pipe, as appending at the end is usually wrong for piped commands.
        if (p.path && cmd && !cmd.includes('|')) {
          const commonTools = ['cat', 'sed', 'head', 'tail', 'grep', 'wc', 'strings', 'ls', 'find'];
          const firstWord = cmd.trim().split(/\s+/)[0];

          if (commonTools.includes(firstWord)) {
            const escapedPath = p.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Support matching path even if it is quoted
            const pathRegex = new RegExp(`(^|\\s)["']?${escapedPath}["']?(\\s|$)`);

            if (!pathRegex.test(cmd)) {
              cmd = `${cmd.trim()} ${p.path}`;
              console.log(chalk.gray(`      🔧 Auto-fixed command: ${cmd}`));
            }
          }
        }

        if (cmd === 'cat' || cmd === 'grep' || cmd === 'sed') {
          return { status: 'error', message: `Command '${cmd}' requires arguments or a path` };
        }

        if (!cmd) return { status: 'error', message: 'Missing command, path, or query' };
        return executeBash({ command: cmd });
      }
    );
  }

  console.log(`✓ Registered ${toolRegistry.tools.size} local MCP tools`);
}

/**
 * Register tools from remote MCP servers (dynamic)
 */
export async function registerRemoteMCPTools(mcpServers) {
  if (!mcpServers || typeof mcpServers !== 'object') {
    console.log(chalk.yellow('    ⚠️  No MCP servers provided to registerRemoteMCPTools'));
    return;
  }

  console.log(chalk.blue(`    🔧 Registering remote MCP tools from ${Object.keys(mcpServers).length} server(s)...`));

  for (const [serverName, config] of Object.entries(mcpServers)) {
    // Skip local dokodemodoor-helper as it's already registered via registerMCPTools()
    if (serverName === 'dokodemodoor-helper') {
      console.log(chalk.gray(`    ⏭️  Skipping ${serverName} (local tools already registered)`));
      continue;
    }

    console.log(chalk.blue(`    🚀 Starting MCP server: ${serverName}`));
    console.log(chalk.gray(`       Command: ${config.command} ${config.args?.join(' ') || ''}`));

    try {
      const proxy = mcpManager.getProxy(serverName, config.command, config.args, config.env, config.cwd);
      console.log(chalk.gray(`       Listing tools from ${serverName}...`));
      const remoteTools = await proxy.listTools();
      console.log(chalk.green(`       ✅ Found ${remoteTools.length} tools from ${serverName}`));

      for (const tool of remoteTools) {
        const fullToolName = `${serverName}__${tool.name}`;
        const underscoredToolName = `${serverName.replace(/-/g, '_')}__${tool.name}`;

        // Use the input schema from MCP directly, but clean it first
        const schema = cleanSchema(tool.inputSchema || { type: 'object', properties: {} });
        schema.__isJsonSchema = true;

        // Create validator for this tool
        const validate = ajv.compile(schema);
        schema.parse = (args) => {
          const valid = validate(args);
          if (!valid) {
            const errorMsg = ajv.errorsText(validate.errors, { dataVar: 'arguments' });
            throw new Error(`Validation failed for ${fullToolName}: ${errorMsg}`);
          }
          return args;
        };

        // Register the remote tool with a proxy handler
        const handler = async (args) => {
          const result = await proxy.callTool(tool.name, args);
          // Convert MCP tool output to simple string for parent agent
          if (result.isError) {
            const errMsg = result.content?.[0]?.text || 'Unknown MCP error';
            return { status: 'error', message: errMsg };
          }
          // If it's a screenshot or has multiple blocks, join them
          let output = result.content?.map(c => c.text || `[${c.type}]`).join('\n') || result;

          return output;
        };

        toolRegistry.register(fullToolName, tool.description || `Remote tool from ${serverName}`, schema, handler);

        // Register alias with underscores if serverName has hyphens
        if (fullToolName !== underscoredToolName) {
          toolRegistry.register(underscoredToolName, tool.description || `Alias for ${fullToolName}`, schema, handler);
        }
      }
      console.log(chalk.green(`    ✅ Registered ${remoteTools.length} tools from remote MCP: ${serverName}`));
    } catch (e) {
      console.error(chalk.red(`    ❌ Failed to register remote MCP tools for ${serverName}`));
      console.error(chalk.red(`       Error: ${e.message}`));
      console.error(chalk.gray(`       Command: ${config.command} ${config.args?.join(' ') || ''}`));
      if (process.env.DEBUG || process.env.DOKODEMODOOR_DEBUG === 'true') {
        console.error(chalk.gray(`       Stack: ${e.stack}`));
      }
      console.log(chalk.yellow(`       ⚠️  Continuing without ${serverName} tools...`));
    }
  }

  console.log(chalk.blue(`    📦 Total tools registered: ${toolRegistry.tools.size}`));
}
