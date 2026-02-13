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
import { mcpManager } from './mcp-proxy.js';

// Initialize Ajv for remote tool validation
// Support Draft 2020-12 and better flexibility for MCP/LLM schemas
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  strictTypes: false,
  allowUnionTypes: true
});
addFormats(ajv);

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


export async function registerMCPTools() {
  // 1. Core Platform Tools (guarded)
  const saveDeliverableModule = await import('../../../mcp-server/src/tools/save-deliverable.js');
  toolRegistry.register('save_deliverable', 'Saves deliverable files with automatic validation.', saveDeliverableModule.SaveDeliverableInputSchema, saveDeliverableModule.saveDeliverable);

  const generateTotpModule = await import('../../../mcp-server/src/tools/generate-totp.js');
  toolRegistry.register('generate_totp', 'Generates 6-digit TOTP code for authentication.', generateTotpModule.GenerateTotpInputSchema, generateTotpModule.generateTotp);

  const taskAgentModule = await import('../../../mcp-server/src/tools/task-agent.js');
  toolRegistry.register('TaskAgent', 'Delegate a task to a specialized sub-agent.', taskAgentModule.TaskAgentInputSchema, taskAgentModule.taskAgent);

  const todoWriteModule = await import('../../../mcp-server/src/tools/task-agent.js');
  toolRegistry.register('TodoWrite', 'Update internal todo list.', todoWriteModule.TodoWriteSchema, todoWriteModule.executeTodoWrite);

  // 2. High-Performance Filesystem Tools
  const listFilesModule = await import('../../../mcp-server/src/tools/list-files.js');
  toolRegistry.register('list_files', listFilesModule.listFilesTool.description, listFilesModule.ListFilesInputSchema, listFilesModule.listFiles);

  const readFileModule = await import('../../../mcp-server/src/tools/read-file.js');
  const readAliases = ['read_file', 'view_file', 'open_file', 'browse_file'];
  for (const alias of readAliases) {
    toolRegistry.register(alias, readFileModule.readFileTool.description, readFileModule.ReadFileInputSchema, readFileModule.readFile);
  }

  const writeFileModule = await import('../../../mcp-server/src/tools/write-file.js');
  toolRegistry.register('write_file', writeFileModule.writeFileTool.description, writeFileModule.WriteFileInputSchema, writeFileModule.writeFile);
  toolRegistry.register('save_file', 'Alias for write_file', writeFileModule.WriteFileInputSchema, writeFileModule.writeFile);

  const searchFilesModule = await import('../../../mcp-server/src/tools/search-tools.js');
  const searchAliases = ['search_file', 'grep', 'rg'];
  for (const alias of searchAliases) {
    toolRegistry.register(alias, searchFilesModule.searchFilesTool.description, searchFilesModule.SearchFileInputSchema, searchFilesModule.searchFiles);
  }

  // 3. Smart Bash Tools (Standard Shell access)
  const bashModule = await import('../../../mcp-server/src/tools/bash-tools.js');
  const bashAliases = ['bash', 'Bash', 'sh', 'execute_command', 'run_command', 'ls', 'find'];
  for (const alias of bashAliases) {
    toolRegistry.register(alias, bashModule.bashTool.description, bashModule.BashInputSchema, bashModule.executeBash);
  }

  // 4. HTTP Protocol Helpers
  const httpHelpersModule = await import('../../../mcp-server/src/tools/http-helpers.js');
  toolRegistry.register('build_http_request', 'Build well-formed HTTP requests.', httpHelpersModule.BuildHttpRequestInputSchema, httpHelpersModule.buildHttpRequest);
  toolRegistry.register('calculate_content_length', 'Calculate exact byte length of request body.', httpHelpersModule.CalculateContentLengthInputSchema, httpHelpersModule.calculateContentLength);
  toolRegistry.register('parse_http_request', 'Parse raw HTTP requests.', httpHelpersModule.ParseHttpRequestInputSchema, httpHelpersModule.parseHttpRequest);

  console.log(`✓ Registered ${toolRegistry.tools.size} unified MCP tools`);
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

  // Import HTTP proxy for http/sse servers
  const { mcpHttpManager } = await import('./mcp-http-proxy.js');

  for (const [serverName, config] of Object.entries(mcpServers)) {
    // Skip local dokodemodoor-helper as it's already registered via registerMCPTools()
    if (serverName === 'dokodemodoor-helper') {
      console.log(chalk.gray(`    ⏭️  Skipping ${serverName} (local tools already registered)`));
      continue;
    }

    // Determine server type
    const serverType = config.type || 'stdio';
    const isHttpBased = serverType === 'http' || serverType === 'sse';

    console.log(chalk.blue(`    🚀 Starting MCP server: ${serverName} (${serverType})`));

    if (isHttpBased) {
      if (!config.url) {
        console.error(chalk.red(`    ❌ HTTP/SSE MCP server ${serverName} missing 'url' field`));
        continue;
      }
      console.log(chalk.gray(`       URL: ${config.url}`));
    } else {
      if (!config.command) {
        console.error(chalk.red(`    ❌ stdio MCP server ${serverName} missing 'command' field`));
        continue;
      }
      console.log(chalk.gray(`       Command: ${config.command} ${config.args?.join(' ') || ''}`));
    }

    try {
      // Get appropriate proxy based on server type
      const proxy = isHttpBased
        ? mcpHttpManager.getProxy(serverName, config.url)
        : mcpManager.getProxy(serverName, config.command, config.args, config.env, config.cwd);

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
      if (isHttpBased) {
        console.error(chalk.gray(`       URL: ${config.url}`));
      } else {
        console.error(chalk.gray(`       Command: ${config.command} ${config.args?.join(' ') || ''}`));
      }
      if (process.env.DEBUG || process.env.DOKODEMODOOR_DEBUG === 'true') {
        console.error(chalk.gray(`       Stack: ${e.stack}`));
      }
      console.log(chalk.yellow(`       ⚠️  Continuing without ${serverName} tools...`));
    }
  }

  console.log(chalk.blue(`    📦 Total tools registered: ${toolRegistry.tools.size}`));
}

