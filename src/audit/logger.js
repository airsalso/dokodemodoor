/**
 * Append-Only Agent Logger
 *
 * Provides crash-safe, append-only logging for agent execution.
 * Uses file streams with immediate flush to prevent data loss.
 */

import fs from 'fs';
import { generateLogPath, generatePromptPath, generateDebugLogPath, atomicWrite, formatTimestamp } from './utils.js';
import { config } from '../config/env.js';

/**
 * AgentLogger - Manages append-only logging for a single agent execution
 */
export class AgentLogger {
  /**
   * @param {Object} sessionMetadata - Session metadata
   * @param {string} agentName - Name of the agent
   * @param {number} attemptNumber - Attempt number (1, 2, 3, ...)
   */
  constructor(sessionMetadata, agentName, attemptNumber) {
    this.sessionMetadata = sessionMetadata;
    this.agentName = agentName;
    this.attemptNumber = attemptNumber;
    this.timestamp = Date.now();

    // Generate log file paths
    this.logPath = generateLogPath(sessionMetadata, agentName, this.timestamp, attemptNumber);
    this.debugLogPath = generateDebugLogPath(sessionMetadata, agentName, this.timestamp, attemptNumber);

    // Create write streams
    this.stream = null;
    this.debugStream = null;
    this.isOpen = false;
    this.isDebugLogEnabled = config.dokodemodoor.agentDebugLog;
  }

  /**
   * Initialize the log stream (creates file and opens stream)
   * @returns {Promise<void>}
   */
  /**
   * [목적] 로깅 스트림 초기화 및 헤더 기록.
   *
   * [호출자]
   * - AuditSession.startAgent()
   */
  async initialize() {
    if (this.isOpen) {
      return; // Already initialized
    }

    // Create write stream with append mode and auto-flush
    this.stream = fs.createWriteStream(this.logPath, {
      flags: 'a', // Append mode
      encoding: 'utf8',
      autoClose: true
    });

    if (this.isDebugLogEnabled) {
      this.debugStream = fs.createWriteStream(this.debugLogPath, {
        flags: 'a',
        encoding: 'utf8',
        autoClose: true
      });
    }

    this.isOpen = true;

    // Write header
    await this.writeHeader();
  }

  /**
   * Write header to log file
   * @private
   * @returns {Promise<void>}
   */
  /**
   * [목적] 로그 헤더 작성.
   *
   * [호출자]
   * - initialize()
   */
  async writeHeader() {
    const header = [
      `========================================`,
      `Agent: ${this.agentName}`,
      `Attempt: ${this.attemptNumber}`,
      `Started: ${formatTimestamp(this.timestamp)}`,
      `Session: ${this.sessionMetadata.id}`,
      `Web URL: ${this.sessionMetadata.webUrl}`,
      `========================================\n`
    ].join('\n');

    const promises = [this.writeRaw(header, this.stream)];
    if (this.debugStream) {
      promises.push(this.writeRaw(header, this.debugStream));
    }
    await Promise.all(promises);
  }

  /**
   * Write raw text to log file with immediate flush
   * @private
   * @param {string} text - Text to write
   * @returns {Promise<void>}
   */
  /**
   * [목적] 원시 텍스트를 스트림에 기록.
   *
   * [호출자]
   * - writeHeader(), logEvent()
   */
  writeRaw(text, stream) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen || !stream) {
        reject(new Error('Logger not initialized or stream closed'));
        return;
      }

      // Write and flush immediately (crash-safe)
      const needsDrain = !stream.write(text, 'utf8', (error) => {
        if (error) {
          reject(error);
        }
      });

      if (needsDrain) {
        // Buffer is full, wait for drain
        const drainHandler = () => {
          stream.removeListener('drain', drainHandler);
          resolve();
        };
        stream.once('drain', drainHandler);
      } else {
        // Buffer has space, resolve immediately
        resolve();
      }
    });
  }

  /**
   * Log an event (tool_start, tool_end, llm_response, etc.)
   * Events are logged as JSON for parseability
   * @param {string} eventType - Type of event
   * @param {Object} eventData - Event data
   * @returns {Promise<void>}
   */
  /**
   * [목적] 이벤트 JSON 라인 기록.
   *
   * [호출자]
   * - AuditSession.logEvent()
   */
  async logEvent(eventType, eventData) {
    const event = {
      type: eventType,
      timestamp: formatTimestamp(),
      data: eventData
    };

    const eventLine = `${JSON.stringify(event)}\n`;
    const promises = [this.writeRaw(eventLine, this.stream)];

    if (this.debugStream) {
      let debugLine = '';
      if (eventType === 'llm_response') {
        debugLine = `[${event.timestamp}] 🤖 ASSISTANT:\n${eventData.content}\n\n`;
      } else if (eventType === 'tool_start') {
        debugLine = `[${event.timestamp}] 🔧 TOOL CALL: ${eventData.toolName}\nInput: ${JSON.stringify(eventData.parameters, null, 2)}\n\n`;
      } else if (eventType === 'tool_end') {
        const resultStr = typeof eventData.result === 'string' ? eventData.result : JSON.stringify(eventData.result, null, 2);
        debugLine = `[${event.timestamp}] ✅ TOOL RESULT:\n${resultStr}\n\n`;
      } else if (eventType === 'agent_start') {
        debugLine = `[${event.timestamp}] 🚀 AGENT STARTED: ${eventData.agentName} (Attempt ${eventData.attemptNumber})\n\n`;
      } else if (eventType === 'agent_end') {
        debugLine = `[${event.timestamp}] 🏁 AGENT ENDED: ${eventData.agentName}\nSuccess: ${eventData.success}, Cost: $${eventData.cost_usd}\n\n`;
      }

      if (debugLine) {
        promises.push(this.writeRaw(debugLine, this.debugStream));
      }
    }

    return Promise.all(promises);
  }

  /**
   * Close the log stream
   * @returns {Promise<void>}
   */
  /**
   * [목적] 로그 스트림 종료.
   *
   * [호출자]
   * - AuditSession.endAgent()
   */
  async close() {
    if (!this.isOpen) {
      return;
    }

    const promises = [];
    if (this.stream) {
      promises.push(new Promise(resolve => this.stream.end(resolve)));
    }
    if (this.debugStream) {
      promises.push(new Promise(resolve => this.debugStream.end(resolve)));
    }

    await Promise.all(promises);
    this.isOpen = false;
    this.stream = null;
    this.debugStream = null;
  }

  /**
   * Save prompt snapshot to prompts directory
   * Static method - doesn't require logger instance
   * @param {Object} sessionMetadata - Session metadata
   * @param {string} agentName - Agent name
   * @param {string} promptContent - Full prompt content
   * @returns {Promise<void>}
   */
  /**
   * [목적] 프롬프트 스냅샷 저장(정적 메서드).
   *
   * [호출자]
   * - AuditSession.startAgent()
   */
  static async savePrompt(sessionMetadata, agentName, promptContent) {
    const promptPath = generatePromptPath(sessionMetadata, agentName);

    // Create header with metadata
    const header = [
      `# Prompt Snapshot: ${agentName}`,
      ``,
      `**Session:** ${sessionMetadata.id}`,
      `**Web URL:** ${sessionMetadata.webUrl}`,
      `**Saved:** ${formatTimestamp()}`,
      ``,
      `---`,
      ``
    ].join('\n');

    const fullContent = header + promptContent;

    // Use atomic write for safety
    await atomicWrite(promptPath, fullContent);
  }
}
