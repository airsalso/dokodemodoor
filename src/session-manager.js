import { fs, path } from 'zx';
import chalk from 'chalk';
import crypto from 'crypto';
import { PentestError } from './error-handling.js';
import { SessionMutex } from './utils/concurrency.js';
import { promptSelection } from './cli/prompts.js';
import { getLocalISOString } from './utils/time-utils.js';
import { generateAuditPath } from './audit/utils.js';

// Generate a session-based log folder path
// NEW FORMAT: {hostname}_{sessionId} (no hash, full UUID for consistency with audit system)
/**
 * [목적] 세션 로그 디렉터리 경로를 결정적으로 생성.
 *
 * [호출자]
 * - src/cli/command-handler.js and audit utilities when writing session logs.
 *
 * [출력 대상]
 * - Returns filesystem path under audit-logs/.
 *
 * [입력 파라미터]
 * - webUrl (string): Target URL.
 * - sessionId (string): Session UUID.
 *
 * [반환값]
 * - string: log directory path.
 *
 * [부작용]
 * - None (pure computation).
 */
export const generateSessionLogPath = (webUrl, sessionId) => {
  let hostname = 'unknown';
  try {
    const url = (webUrl && webUrl.includes('://')) ? webUrl : `http://${webUrl || 'localhost'}`;
    hostname = new URL(url).hostname.replace(/[^a-zA-Z0-9-]/g, '-');
  } catch (e) {
    // Fallback if URL parsing fails
  }
  const sessionFolderName = `${hostname}_${sessionId}`;
  return path.join(process.cwd(), 'audit-logs', sessionFolderName);
};

const sessionMutex = new SessionMutex();

// Agent definitions according to PRD
export const AGENTS = Object.freeze({
  // Phase 1 - Pre-reconnaissance
  'pre-recon': {
    name: 'pre-recon',
    displayName: 'Pre-recon agent',
    phase: 'pre-reconnaissance',
    order: 1,
    prerequisites: []
  },

  // Phase 2 - Reconnaissance
  'login-check': {
    name: 'login-check',
    displayName: 'Login verification agent',
    phase: 'reconnaissance',
    order: 2,
    prerequisites: ['pre-recon']
  },
  'recon': {
    name: 'recon',
    displayName: 'Recon agent',
    phase: 'reconnaissance',
    order: 3,
    prerequisites: ['login-check']
  },
  'recon-verify': {
    name: 'recon-verify',
    displayName: 'Recon Verifier agent',
    phase: 'reconnaissance',
    order: 4,
    prerequisites: ['recon']
  },
  'api-fuzzer': {
    name: 'api-fuzzer',
    displayName: 'API Fuzzer agent',
    phase: 'api-fuzzing',
    order: 5,
    prerequisites: ['recon-verify']
  },

  // Phase 3 - Vulnerability Analysis
  'sqli-vuln': {
    name: 'sqli-vuln',
    displayName: 'SQL Injection vuln agent',
    phase: 'vulnerability-analysis',
    order: 6,
    prerequisites: ['api-fuzzer']
  },
  'codei-vuln': {
    name: 'codei-vuln',
    displayName: 'Code Injection vuln agent',
    phase: 'vulnerability-analysis',
    order: 7,
    prerequisites: ['api-fuzzer']
  },
  'ssti-vuln': {
    name: 'ssti-vuln',
    displayName: 'SSTI vuln agent',
    phase: 'vulnerability-analysis',
    order: 8,
    prerequisites: ['api-fuzzer']
  },
  'pathi-vuln': {
    name: 'pathi-vuln',
    displayName: 'Path Injection vuln agent',
    phase: 'vulnerability-analysis',
    order: 9,
    prerequisites: ['api-fuzzer']
  },
  'xss-vuln': {
    name: 'xss-vuln',
    displayName: 'XSS vuln agent',
    phase: 'vulnerability-analysis',
    order: 10,
    prerequisites: ['api-fuzzer']
  },
  'auth-vuln': {
    name: 'auth-vuln',
    displayName: 'Auth vuln agent',
    phase: 'vulnerability-analysis',
    order: 11,
    prerequisites: ['api-fuzzer']
  },
  'ssrf-vuln': {
    name: 'ssrf-vuln',
    displayName: 'SSRF vuln agent',
    phase: 'vulnerability-analysis',
    order: 12,
    prerequisites: ['api-fuzzer']
  },
  'authz-vuln': {
    name: 'authz-vuln',
    displayName: 'Authz vuln agent',
    phase: 'vulnerability-analysis',
    order: 13,
    prerequisites: ['api-fuzzer']
  },

  // Phase 4 - Exploitation
  'sqli-exploit': {
    name: 'sqli-exploit',
    displayName: 'SQL Injection exploit agent',
    phase: 'exploitation',
    order: 14,
    prerequisites: ['sqli-vuln']
  },
  'codei-exploit': {
    name: 'codei-exploit',
    displayName: 'Code Injection exploit agent',
    phase: 'exploitation',
    order: 15,
    prerequisites: ['codei-vuln']
  },
  'ssti-exploit': {
    name: 'ssti-exploit',
    displayName: 'SSTI exploit agent',
    phase: 'exploitation',
    order: 16,
    prerequisites: ['ssti-vuln']
  },
  'pathi-exploit': {
    name: 'pathi-exploit',
    displayName: 'Path Injection exploit agent',
    phase: 'exploitation',
    order: 17,
    prerequisites: ['pathi-vuln']
  },
  'xss-exploit': {
    name: 'xss-exploit',
    displayName: 'XSS exploit agent',
    phase: 'exploitation',
    order: 18,
    prerequisites: ['xss-vuln']
  },
  'auth-exploit': {
    name: 'auth-exploit',
    displayName: 'Auth exploit agent',
    phase: 'exploitation',
    order: 19,
    prerequisites: ['auth-vuln']
  },
  'ssrf-exploit': {
    name: 'ssrf-exploit',
    displayName: 'SSRF exploit agent',
    phase: 'exploitation',
    order: 20,
    prerequisites: ['ssrf-vuln']
  },
  'authz-exploit': {
    name: 'authz-exploit',
    displayName: 'Authz exploit agent',
    phase: 'exploitation',
    order: 21,
    prerequisites: ['authz-vuln']
  },

  // Phase 5 - Reporting
  'report': {
    name: 'report',
    displayName: 'Report agent',
    phase: 'reporting',
    order: 22,
    prerequisites: ['sqli-exploit', 'codei-exploit', 'ssti-exploit', 'pathi-exploit', 'xss-exploit', 'auth-exploit', 'ssrf-exploit', 'authz-exploit']
  },

  // Phase 6 - OSV Analysis (Standalone compatible)
  'osv-analysis': {
    name: 'osv-analysis',
    displayName: 'OSV Analysis agent',
    phase: 'osv-analysis',
    order: 23,
    prerequisites: []
  },

  // Reverse Engineering agents (Standalone pipeline via re-scanner.mjs)
  're-inventory': {
    name: 're-inventory',
    displayName: 'RE Pre-Inventory agent',
    phase: 're-inventory',
    order: 101,
    prerequisites: []
  },
  're-static': {
    name: 're-static',
    displayName: 'RE Static Analysis agent',
    phase: 're-static-analysis',
    order: 102,
    prerequisites: ['re-inventory']
  },
  're-dynamic': {
    name: 're-dynamic',
    displayName: 'RE Dynamic Observation agent',
    phase: 're-dynamic-observation',
    order: 103,
    prerequisites: ['re-static']
  },
  're-instrument': {
    name: 're-instrument',
    displayName: 'RE Runtime Instrumentation agent',
    phase: 're-dynamic-observation',
    order: 104,
    prerequisites: ['re-static']
  },
  're-network': {
    name: 're-network',
    displayName: 'RE Network Analysis agent',
    phase: 're-network-analysis',
    order: 105,
    prerequisites: ['re-dynamic', 're-instrument']
  },
  're-report': {
    name: 're-report',
    displayName: 'RE Report agent',
    phase: 're-reporting',
    order: 106,
    prerequisites: ['re-network']
  }

});

// Phase definitions
export const PHASES = Object.freeze({
  'pre-reconnaissance': ['pre-recon'],
  'reconnaissance': ['login-check', 'recon', 'recon-verify'],
  'api-fuzzing': ['api-fuzzer'],
  'vulnerability-analysis': ['sqli-vuln', 'codei-vuln', 'ssti-vuln', 'pathi-vuln', 'xss-vuln', 'auth-vuln', 'ssrf-vuln', 'authz-vuln'],
  'exploitation': ['sqli-exploit', 'codei-exploit', 'ssti-exploit', 'pathi-exploit', 'xss-exploit', 'auth-exploit', 'ssrf-exploit', 'authz-exploit'],
  'reporting': ['report']
});

export const PHASE_ORDER = Object.freeze([
  'pre-reconnaissance',
  'reconnaissance',
  'api-fuzzing',
  'vulnerability-analysis',
  'exploitation',
  'reporting'
]);

// Reverse Engineering phase definitions (standalone pipeline)
export const RE_PHASES = Object.freeze({
  're-inventory': ['re-inventory'],
  're-static-analysis': ['re-static'],
  're-dynamic-observation': ['re-dynamic', 're-instrument'],
  're-network-analysis': ['re-network'],
  're-reporting': ['re-report']
});

export const RE_PHASE_ORDER = Object.freeze([
  're-inventory',
  're-static-analysis',
  're-dynamic-observation',
  're-network-analysis',
  're-reporting'
]);


/**
 * [목적] 에이전트 이름을 단계 순서 인덱스로 매핑.
 *
 * [호출자]
 * - dokodemodoor.mjs to decide which phase to resume.
 *
 * [출력 대상]
 * - Returns 1-based phase index for orchestration.
 *
 * [입력 파라미터]
 * - agentName (string): Agent identifier.
 *
 * [반환값]
 * - number: phase index (1..N).
 */
export const getPhaseIndexForAgent = (agentName) => {
  if (agentName === 'osv-analysis') return 99; // Standalone/manual bypass
  if (agentName.startsWith('re-')) return 100; // RE pipeline bypass (standalone)
  const agent = validateAgent(agentName);
  const phaseIndex = PHASE_ORDER.indexOf(agent.phase);

  return phaseIndex === -1 ? 1 : phaseIndex + 1;
};

// Session store file path
const STORE_FILE = path.join(process.cwd(), '.dokodemodoor-store.json');

// Load sessions from store file
/**
 * [목적] 디스크의 세션 상태를 로드.
 *
 * [호출자]
 * - createSession(), getSession(), updateSession(), listSessions().
 *
 * [출력 대상]
 * - Returns a store object containing sessions map.
 *
 * [반환값]
 * - Promise<object>: { sessions: { [id]: session } }.
 *
 * [부작용]
 * - Filesystem read of .dokodemodoor-store.json.
 *
 * [에러 처리]
 * - Returns empty store on read/parse errors and logs a warning.
 */
const loadSessions = async () => {
  try {
    if (!await fs.pathExists(STORE_FILE)) {
      return { sessions: {} };
    }

    const content = await fs.readFile(STORE_FILE, 'utf8');
    const store = JSON.parse(content);

    // Validate store structure
    if (!store || typeof store !== 'object' || !store.sessions) {
      console.log(chalk.yellow('⚠️ Invalid session store format, creating new store'));
      return { sessions: {} };
    }

    return store;
  } catch (error) {
    console.log(chalk.yellow(`⚠️ Failed to load session store: ${error.message}, creating new store`));
    return { sessions: {} };
  }
};

// Save sessions to store file atomically
/**
 * [목적] 세션 저장소를 디스크에 저장.
 *
 * [호출자]
 * - createSession(), updateSession(), deleteSession(), deleteAllSessions().
 *
 * [출력 대상]
 * - Writes .dokodemodoor-store.json.
 *
 * [입력 파라미터]
 * - store (object): Session store to write.
 *
 * [반환값]
 * - Promise<void>
 *
 * [부작용]
 * - Filesystem write to store file (atomic temp swap).
 */
const saveSessions = async (store) => {
  try {
    const tempFile = `${STORE_FILE}.tmp`;
    await fs.writeJSON(tempFile, store, { spaces: 2 });
    await fs.move(tempFile, STORE_FILE, { overwrite: true });
  } catch (error) {
    throw new PentestError(
      `Failed to save session store: ${error.message}`,
      'filesystem',
      false,
      { storeFile: STORE_FILE, originalError: error.message }
    );
  }
};

// Find existing session for the same web URL and repository path
/**
 * [목적] 동일 대상의 기존 세션을 탐색(진행 중 우선).
 *
 * [호출자]
 * - createSession()에서 신규 생성 전
 *
 * [출력 대상]
 * - 가장 적합한 세션 또는 null 반환
 *
 * [입력 파라미터]
 * - webUrl (string)
 * - targetRepo (string)
 *
 * [반환값]
 * - Promise<object|null>
 */
const findExistingSession = async (webUrl, targetRepo) => {
  const store = await loadSessions();
  const sessions = Object.values(store.sessions);

  // Normalize paths for comparison
  const normalizedTargetRepo = path.resolve(targetRepo);

  const matches = sessions.filter(session => {
    const normalizedSessionRepo = path.resolve(session.targetRepo || session.repoPath);
    return session.webUrl === webUrl && normalizedSessionRepo === normalizedTargetRepo;
  });

  if (matches.length === 0) {
    return null;
  }

  // Filter out sessions that are already functionally complete
  const activeSessions = matches.filter(session => {
    const { isPipelineComplete } = getSessionStatus(session);
    return !isPipelineComplete;
  });

  if (activeSessions.length === 0) {
    return null;
  }

  return activeSessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))[0];
};

// Generate session ID as unique UUID
/**
 * [목적] 고유 세션 식별자 생성.
 *
 * [호출자]
 * - createSession().
 *
 * [출력 대상]
 * - Returns a UUID string.
 *
 * [반환값]
 * - string: UUID.
 */
const generateSessionId = () => {
  // Always generate a unique UUID for each session
  return crypto.randomUUID();
};

// Create new session or return existing one
/**
 * [목적] 대상 레포/URL에 대한 세션 생성 또는 재사용.
 *
 * [호출자]
 * - dokodemodoor.mjs during startup.
 *
 * [출력 대상]
 * - Persists session store and returns session object.
 *
 * [입력 파라미터]
 * - webUrl (string)
 * - repoPath (string)
 * - configFile (string|null)
 * - targetRepo (string|null)
 *
 * [반환값]
 * - Promise<object>: session data.
 *
 * [부작용]
 * - Reads/writes session store.
 *
 * [에러 처리]
 * - Throws PentestError on store persistence failures.
 */
export const createSession = async (webUrl, repoPath, configFile = null, targetRepo = null) => {
  // Use targetRepo if provided, otherwise use repoPath
  const resolvedTargetRepo = targetRepo || repoPath;

  // Check for existing session first
  const existingSession = await findExistingSession(webUrl, resolvedTargetRepo);

  if (existingSession) {
    // If session is not completed, reuse it
    if (existingSession.status !== 'completed') {
      console.log(chalk.blue(`📝 Reusing existing session: ${existingSession.id.substring(0, 8)}...`));
      const pipelineAgents = new Set(Object.values(PHASES).flat());
      const completedCount = new Set([
        ...(existingSession.completedAgents || []),
        ...(existingSession.skippedAgents || [])
      ].filter(name => pipelineAgents.has(name))).size;

      console.log(chalk.gray(`   Progress: ${completedCount}/${pipelineAgents.size} agents completed`));

      // Update last activity and ensure status is 'in-progress' upon reuse
      await updateSession(existingSession.id, {
        status: 'in-progress',
        lastActivity: getLocalISOString()
      });
      return existingSession;

    }

    // If completed, create a new session (allows re-running after completion)
    console.log(chalk.gray(`Previous session was completed, creating new session...`));
  }

  const sessionId = generateSessionId();

  // STANDARD: All sessions use 'id' field (NOT 'sessionId')
  // This is the canonical session structure used throughout the codebase
  const session = {
    id: sessionId,
    webUrl,
    repoPath,
    configFile,
    targetRepo: resolvedTargetRepo,
    status: 'in-progress',
    completedAgents: [],
    skippedAgents: [],
    failedAgents: [],
    runningAgents: [],
    checkpoints: {},
    createdAt: getLocalISOString(),
    lastActivity: getLocalISOString()
  };

  const store = await loadSessions();
  store.sessions[sessionId] = session;
  await saveSessions(store);

  // Auto-cleanup stale sessions on new session creation
  // This handles sessions that were 'in-progress' but crashed/killed without cleanup
  await cleanupStaleSessions(sessionId);

  return session;
};

/**
 * [목적] 장시간 활동이 없는 'in-progress' 세션들을 'interrupted'로 정리.
 *
 * @param {string} currentSessionId - 현재 실행 중인 세션 ID (정리 대상에서 제외)
 */
export const cleanupStaleSessions = async (currentSessionId = null) => {
  const store = await loadSessions();
  let updated = false;
  const now = new Date();
  const STALE_THRESHOLD_MS = 1000 * 60 * 60; // 60 minutes (1 hour)


  for (const id in store.sessions) {
    if (id === currentSessionId) continue;

    const session = store.sessions[id];
    if (session.status === 'in-progress') {
      const lastActivity = session.lastActivity ? new Date(session.lastActivity) : new Date(session.createdAt);
      if (now - lastActivity > STALE_THRESHOLD_MS) {
        session.status = 'interrupted';
        if (Array.isArray(session.runningAgents) && session.runningAgents.length > 0) {
          const failed = new Set([...(session.failedAgents || []), ...session.runningAgents]);
          session.failedAgents = Array.from(failed);
          session.runningAgents = [];
        }
        updated = true;
        console.log(chalk.gray(`    🧹 Auto-cleaned stale session: ${id.substring(0, 8)} (marked as interrupted)`));
      }
    }
  }

  if (updated) {
    await saveSessions(store);
  }
};


// Get session by ID
/**
 * [목적] 저장소에서 ID로 세션 조회.
 *
 * [호출자]
 * - CLI handlers and checkpoint orchestration.
 *
 * [출력 대상]
 * - Returns session object or null.
 *
 * [입력 파라미터]
 * - sessionId (string)
 *
 * [반환값]
 * - Promise<object|null>
 */
export const getSession = async (sessionId) => {
  const store = await loadSessions();
  const session = store.sessions[sessionId] || null;
  if (!session) return null;

  if (!Array.isArray(session.skippedAgents)) {
    session.skippedAgents = [];
  }

  return session;
};

// Update session
/**
 * [목적] 세션 레코드 부분 업데이트 적용.
 *
 * [호출자]
 * - dokodemodoor.mjs and checkpoint-manager.
 *
 * [출력 대상]
 * - Persists session updates and returns updated session.
 *
 * [입력 파라미터]
 * - sessionId (string)
 * - updates (object)
 *
 * [반환값]
 * - Promise<object>
 *
 * [부작용]
 * - Writes session store to disk.
 */
export const updateSession = async (sessionId, updates) => {
  // Use lock to ensure atomic update
  const unlock = await sessionMutex.lock(sessionId);
  try {
    const store = await loadSessions();

    if (!store.sessions[sessionId]) {
      throw new PentestError(
        `Session ${sessionId} not found`,
        'validation',
        false,
        { sessionId }
      );
    }

    // Preserve the current state before applying updates
    const currentState = store.sessions[sessionId];
    const newState = {
      ...currentState,
      ...updates
    };

    // Auto-sync status if any agent-related fields were updated
    const agentFields = ['completedAgents', 'failedAgents', 'skippedAgents', 'runningAgents'];
    const wasAgentListUpdated = Object.keys(updates).some(key => agentFields.includes(key));

    if (wasAgentListUpdated) {
      const { status } = getSessionStatus(newState);
      newState.status = status;
    }

    store.sessions[sessionId] = {
      ...newState,
      lastActivity: getLocalISOString()
    };

    await saveSessions(store);
    return store.sessions[sessionId];
  } finally {
    unlock();
  }
};

// List all sessions
/**
 * [목적] 저장된 모든 세션 반환.
 *
 * [호출자]
 * - selectSession() for interactive choices.
 *
 * [출력 대상]
 * - Returns array of sessions.
 *
 * [반환값]
 * - Promise<array>
 */
const listSessions = async () => {
  const store = await loadSessions();
  return Object.values(store.sessions);
};

// Find session by ID or substring, falling back to selection if ambiguous or missing
/**
 * [목적] ID 또는 대화형 선택으로 세션 결정.
 *
 * [호출자]
 * - CLI command handler when a session ID is optional.
 *
 * [출력 대상]
 * - Returns a single session object.
 *
 * [입력 파라미터]
 * - idOrQuery (string|null): Full or partial session ID.
 *
 * [반환값]
 * - Promise<object>
 *
 * [에러 처리]
 * - Throws PentestError when ambiguous or none found.
 */
export const findSessionByIdOrSelection = async (idOrQuery = null) => {
  const store = await loadSessions();
  const sessions = Object.values(store.sessions);

  if (sessions.length === 0) {
    throw new PentestError(
      'No pentest sessions found. Run a normal pentest first to create a session.',
      'validation',
      false
    );
  }

  // If ID provided, try exact match or substring
  if (idOrQuery) {
    // 1. Exact match
    if (store.sessions[idOrQuery]) {
      return store.sessions[idOrQuery];
    }

    // 2. Substring match (for convenience, e.g. first 8 chars of UUID)
    const matches = sessions.filter(s => s.id.startsWith(idOrQuery));
    if (matches.length === 1) {
      return matches[0];
    } else if (matches.length > 1) {
      throw new PentestError(
        `Session ID '${idOrQuery}' is ambiguous. Multiple matches found.`,
        'validation',
        false,
        { idOrQuery, matches: matches.map(m => m.id) }
      );
    }

    // 3. Fallback: warn and proceed to selection if interactive, else fail
    console.log(chalk.yellow(`⚠️  Session ID '${idOrQuery}' not found.`));
  }

  // Fallback to interactive selection
  return await selectSession();
};

// Interactive session selection
/**
 * [목적] 사용자에게 세션 선택을 요청.
 *
 * [호출자]
 * - findSessionByIdOrSelection().
 *
 * [출력 대상]
 * - Returns selected session object.
 *
 * [반환값]
 * - Promise<object>
 *
 * [부작용]
 * - CLI I/O via promptSelection and console output.
 */
export const selectSession = async () => {
  const sessions = await listSessions();

  if (sessions.length === 0) {
    throw new PentestError(
      'No pentest sessions found. Run a normal pentest first to create a session.',
      'validation',
      false
    );
  }

  if (sessions.length === 1) {
    return sessions[0];
  }

  // Display session options
  console.log(chalk.cyan('\nMultiple pentest sessions found:\n'));

  sessions.forEach((session, index) => {
    const completedCount = new Set([
      ...(session.completedAgents || []),
      ...(session.skippedAgents || [])
    ]).size;
    const totalAgents = Object.keys(AGENTS).length;
    const timeAgo = getTimeAgo(session.lastActivity);

    // Use dynamic status calculation instead of stored status
    const { status } = getSessionStatus(session);
    const statusColor = status === 'completed' ? chalk.green : chalk.blue;
    const statusIcon = status === 'completed' ? '✅' : '🔄';

    let hostname = 'unknown';
    try {
      const url = (session.webUrl && session.webUrl.includes('://')) ? session.webUrl : `http://${session.webUrl || 'localhost'}`;
      hostname = new URL(url).hostname;
    } catch (e) {}
    console.log(statusColor(`${index + 1}) ${hostname} + ${path.basename(session.repoPath)} [${status}]`));
    console.log(chalk.gray(`   Last activity: ${timeAgo}, Completed: ${completedCount}/${totalAgents} agents`));
    console.log(chalk.gray(`   Session ID: ${session.id}`));

    if (session.configFile) {
      console.log(chalk.gray(`   Config: ${session.configFile}`));
    }

    console.log(); // Empty line between sessions
  });

  // Get user selection
  return await promptSelection(
    chalk.cyan(`Select session (1-${sessions.length}):`),
    sessions
  );
};

// Validate agent name
/**
 * [목적] 에이전트 이름 유효성 검사 후 정의 반환.
 *
 * [호출자]
 * - getPhaseIndexForAgent(), validateAgentRange(), checkpoint-manager flows.
 *
 * [출력 대상]
 * - Returns AGENTS[agentName] or throws.
 *
 * [입력 파라미터]
 * - agentName (string)
 *
 * [반환값]
 * - object: agent definition.
 *
 * [에러 처리]
 * - Throws PentestError if invalid.
 */
export const validateAgent = (agentName) => {
  if (!AGENTS[agentName]) {
    throw new PentestError(
      `Agent '${agentName}' not recognized. Use --list-agents to see valid names.`,
      'validation',
      false,
      { agentName, validAgents: Object.keys(AGENTS) }
    );
  }
  return AGENTS[agentName];
};

// Validate agent range
/**
 * [목적] 에이전트 범위를 순서대로 검증/확장.
 *
 * [호출자]
 * - CLI flows (run agent range).
 *
 * [출력 대상]
 * - Returns ordered agent list between start and end (inclusive).
 *
 * [입력 파라미터]
 * - startAgent (string)
 * - endAgent (string)
 *
 * [반환값]
 * - array: ordered agent definitions.
 *
 * [에러 처리]
 * - Throws PentestError for invalid order or names.
 */
export const validateAgentRange = (startAgent, endAgent) => {
  const start = validateAgent(startAgent);
  const end = validateAgent(endAgent);

  if (start.order >= end.order) {
    throw new PentestError(
      `End agent '${endAgent}' must come after start agent '${startAgent}' in sequence.`,
      'validation',
      false,
      { startAgent, endAgent, startOrder: start.order, endOrder: end.order }
    );
  }

  // Get all agents in range
  const agentList = Object.values(AGENTS)
    .filter(agent => agent.order >= start.order && agent.order <= end.order)
    .sort((a, b) => a.order - b.order);

  return agentList;
};

// Validate phase name
/**
 * [목적] 단계 이름을 목록과 비교해 검증.
 *
 * [호출자]
 * - CLI phase selection and checkpoint-manager.
 *
 * [출력 대상]
 * - Returns phase name or throws.
 *
 * [입력 파라미터]
 * - phaseName (string)
 *
 * [반환값]
 * - string: validated phase name.
 *
 * [에러 처리]
 * - Throws PentestError if invalid.
 */
export const validatePhase = (phaseName) => {
  if (!PHASES[phaseName]) {
    throw new PentestError(
      `Phase '${phaseName}' not recognized. Valid phases: ${Object.keys(PHASES).join(', ')}`,
      'validation',
      false,
      { phaseName, validPhases: Object.keys(PHASES) }
    );
  }
  return PHASES[phaseName].map(agentName => AGENTS[agentName]);
};

// Check prerequisites for an agent
/**
 * [목적] 에이전트 실행 전 선행 조건 완료 확인.
 *
 * [호출자]
 * - checkpoint-manager before running agents.
 *
 * [출력 대상]
 * - Returns true or throws if prerequisites missing.
 *
 * [입력 파라미터]
 * - session (object)
 * - agentName (string)
 *
 * [반환값]
 * - boolean
 *
 * [에러 처리]
 * - Throws PentestError when prerequisites are missing.
 */
export const checkPrerequisites = (session, agentName) => {
  const agent = validateAgent(agentName);
  const completedOrSkipped = new Set([
    ...(session.completedAgents || []),
    ...(session.skippedAgents || [])
  ]);

  const missingPrereqs = agent.prerequisites.filter(prereq =>
    !completedOrSkipped.has(prereq)
  );

  if (missingPrereqs.length > 0) {
    throw new PentestError(
      `Cannot run '${agentName}': prerequisite agent(s) not completed: ${missingPrereqs.join(', ')}`,
      'validation',
      false,
      { agentName, missingPrerequisites: missingPrereqs, completedAgents: session.completedAgents }
    );
  }

  return true;
};

// Get next suggested agent
/**
 * [목적] 완료 상태/선행 조건 기준으로 다음 실행 에이전트 결정.
 *
 * [호출자]
 * - dokodemodoor.mjs and CLI resume flows.
 *
 * [출력 대상]
 * - Returns the next agent definition or undefined.
 *
 * [입력 파라미터]
 * - session (object)
 *
 * [반환값]
 * - object|undefined
 */
export const getNextAgent = (session) => {
  const completed = new Set([
    ...(session.completedAgents || []),
    ...(session.skippedAgents || [])
  ]);
  const failed = new Set(session.failedAgents);

  // Find the next agent that hasn't been completed and has all prerequisites
  const nextAgent = Object.values(AGENTS)
    .filter(a => a.name !== 'osv-analysis' && !a.name.startsWith('re-')) // Exclude standalone agents from main sequence
    .sort((a, b) => a.order - b.order)
    .find(agent => {
      if (completed.has(agent.name)) return false; // Already completed

      // Check if all prerequisites are completed
      const prereqsMet = agent.prerequisites.every(prereq => completed.has(prereq));
      return prereqsMet;
    });

  return nextAgent;
};

// Mark agent as completed with checkpoint
// NOTE: Timing, cost, and validation data now managed by AuditSession (audit-logs/session.json)
// DokodemoDoor store contains ONLY orchestration state (completedAgents, checkpoints)
/**
 * [목적] 에이전트를 완료 처리하고 체크포인트 기록.
 *
 * [호출자]
 * - checkpoint-manager after successful agent execution.
 *
 * [출력 대상]
 * - Updates session store (completedAgents/checkpoints).
 *
 * [입력 파라미터]
 * - sessionId (string)
 * - agentName (string)
 * - checkpointCommit (string)
 *
 * [반환값]
 * - Promise<void>
 *
 * [부작용]
 * - Writes session store; uses session mutex for concurrency.
 */
export const markAgentCompleted = async (sessionId, agentName, checkpointCommit) => {
  validateAgent(agentName);

  // Get fresh session data
  const session = await getSession(sessionId);
  if (!session) {
    throw new PentestError(`Session ${sessionId} not found`, 'validation', false);
  }

  const updates = {
    completedAgents: [...new Set([...(session.completedAgents || []), agentName])],
    skippedAgents: (session.skippedAgents || []).filter(agent => agent !== agentName),
    failedAgents: (session.failedAgents || []).filter(agent => agent !== agentName),
    runningAgents: (session.runningAgents || []).filter(agent => agent !== agentName),
    checkpoints: {
      ...session.checkpoints,
      [agentName]: checkpointCommit
    }
  };

  // Sync session status
  const { status } = getSessionStatus({ ...session, ...updates });
  updates.status = status;

  return await updateSession(sessionId, updates);
};

// Mark agent as failed
/**
 * [목적] 에이전트를 실패 처리하고 세션 상태 갱신.
 *
 * [호출자]
 * - checkpoint-manager when an agent fails.
 *
 * [출력 대상]
 * - Updates session store failedAgents/completedAgents.
 *
 * [입력 파라미터]
 * - sessionId (string)
 * - agentName (string)
 *
 * [반환값]
 * - Promise<object>
 *
 * [부작용]
 * - Writes session store.
 */
export const markAgentFailed = async (sessionId, agentName) => {
  validateAgent(agentName);

  const session = await getSession(sessionId);
  if (!session) {
    throw new PentestError(`Session ${sessionId} not found`, 'validation', false);
  }

  const updates = {
    failedAgents: [...new Set([...(session.failedAgents || []), agentName])],
    skippedAgents: (session.skippedAgents || []).filter(agent => agent !== agentName),
    completedAgents: (session.completedAgents || []).filter(agent => agent !== agentName),
    runningAgents: (session.runningAgents || []).filter(agent => agent !== agentName)
  };

  // Sync session status
  const { status } = getSessionStatus({ ...session, ...updates });
  updates.status = status;

  return await updateSession(sessionId, updates);
};

// Mark agent as skipped
/**
 * [목적] 에이전트를 스킵 처리하고 세션 상태 갱신.
 *
 * [호출자]
 * - checkpoint-manager when an agent is intentionally skipped.
 *
 * [출력 대상]
 * - Updates session store skippedAgents/completedAgents/failedAgents.
 *
 * [입력 파라미터]
 * - sessionId (string)
 * - agentName (string)
 *
 * [반환값]
 * - Promise<object>
 *
 * [부작용]
 * - Writes session store.
 */
export const markAgentSkipped = async (sessionId, agentName) => {
  validateAgent(agentName);

  const session = await getSession(sessionId);
  if (!session) {
    throw new PentestError(`Session ${sessionId} not found`, 'validation', false);
  }

  const updates = {
    skippedAgents: [...new Set([...(session.skippedAgents || []), agentName])],
    failedAgents: (session.failedAgents || []).filter(agent => agent !== agentName),
    completedAgents: (session.completedAgents || []).filter(agent => agent !== agentName),
    runningAgents: (session.runningAgents || []).filter(agent => agent !== agentName)
  };

  // Sync session status
  const { status } = getSessionStatus({ ...session, ...updates });
  updates.status = status;

  return await updateSession(sessionId, updates);
};

// Mark agent as running
/**
 * [목적] 에이전트를 수행 중 상태로 표시.
 *
 * [호출자]
 * - checkpoint-manager when an agent starts execution.
 */
export const markAgentRunning = async (sessionId, agentName) => {
  validateAgent(agentName);

  const session = await getSession(sessionId);
  if (!session) {
    throw new PentestError(`Session ${sessionId} not found`, 'validation', false);
  }

  const updates = {
    runningAgents: [...new Set([...(session.runningAgents || []), agentName])],
    // If it was marked as failed before, clear it when we start running again
    failedAgents: (session.failedAgents || []).filter(a => a !== agentName)
  };

  // Sync session status
  const { status } = getSessionStatus({ ...session, ...updates });
  updates.status = status;

  return await updateSession(sessionId, updates);
};

// Get time ago helper
/**
 * [목적] 타임스탬프를 상대 시간 문자열로 변환.
 *
 * [호출자]
 * - selectSession() display.
 *
 * [출력 대상]
 * - Returns human-readable relative time.
 *
 * [입력 파라미터]
 * - timestamp (string|Date)
 *
 * [반환값]
 * - string
 */
const getTimeAgo = (timestamp) => {
  const now = new Date();
  const past = new Date(timestamp);
  const diffMs = now - past;

  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 60) {
    return `${diffMins}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else {
    return `${diffDays}d ago`;
  }
};

// Get session status summary
/**
 * [목적] 세션 파생 상태 메트릭 계산.
 *
 * [호출자]
 * - selectSession() UI and status displays.
 *
 * [출력 대상]
 * - Returns status object with counts and percentage.
 *
 * [입력 파라미터]
 * - session (object)
 *
 * [반환값]
 * - object
 */
export const getSessionStatus = (session) => {
  // Only count agents that belong to a defined phase for the progress bar
  const pipelineAgents = new Set(Object.values(PHASES).flat());
  const totalAgents = pipelineAgents.size;

  const completedCount = new Set([
    ...(session.completedAgents || []),
    ...(session.skippedAgents || [])
  ].filter(name => pipelineAgents.has(name))).size;

  const failedCount = (session.failedAgents || []).filter(name => pipelineAgents.has(name)).length;

  const isPipelineComplete = completedCount === totalAgents;

  let status;
  if ((session.runningAgents || []).length > 0) {
    status = 'running';
  } else if (failedCount > 0) {
    status = 'failed';
  } else if (isPipelineComplete) {
    status = 'completed';
  } else {
    status = 'in-progress';
  }

  return {
    status,
    completedCount,
    totalAgents,
    failedCount,
    completionPercentage: Math.round((completedCount / totalAgents) * 100),
    isPipelineComplete
  };
};

// Calculate comprehensive summary statistics for vulnerability analysis
/**
 * [목적] 취약점 분석 단계 완료 상태 요약.
 *
 * [호출자]
 * - CLI status and reporting utilities.
 *
 * [출력 대상]
 * - Returns frozen summary object.
 *
 * [입력 파라미터]
 * - session (object)
 *
 * [반환값]
 * - object
 *
 * [주의사항]
 * - Does not parse queue files; counts are completion-only.
 */
export const calculateVulnerabilityAnalysisSummary = (session) => {
  const vulnAgents = PHASES['vulnerability-analysis'];
  const completedVulnAgents = session.completedAgents.filter(agent => vulnAgents.includes(agent));

  // NOTE: Actual vulnerability counts require reading queue files
  // This summary only shows completion counts
  return Object.freeze({
    totalAnalyses: completedVulnAgents.length,
    totalVulnerabilities: 0,
    exploitationCandidates: 0,
    completedAgents: completedVulnAgents
  });
};

// Calculate exploitation summary statistics
/**
 * [목적] 익스플로잇 단계 완료 상태 요약.
 *
 * [호출자]
 * - CLI status and reporting utilities.
 *
 * [출력 대상]
 * - Returns frozen summary object.
 *
 * [입력 파라미터]
 * - session (object)
 *
 * [반환값]
 * - object
 *
 * [주의사항]
 * - Does not inspect evidence files; counts are completion-only.
 */
export const calculateExploitationSummary = (session) => {
  const exploitAgents = PHASES['exploitation'];
  const completedExploitAgents = (session.completedAgents || []).filter(agent => exploitAgents.includes(agent));
  const skippedExploitAgents = (session.skippedAgents || []).filter(agent => exploitAgents.includes(agent));

  // NOTE: Eligibility requires reading queue files
  // This summary only shows completion counts
  return Object.freeze({
    totalAttempts: completedExploitAgents.length,
    eligibleExploits: completedExploitAgents.length + skippedExploitAgents.length,
    skippedExploits: skippedExploitAgents.length,
    completedAgents: completedExploitAgents
  });
};

// Rollback session to specific agent checkpoint
/**
 * [목적] 세션 상태를 특정 에이전트 체크포인트로 롤백.
 *
 * [호출자]
 * - CLI rollback commands and checkpoint-manager.
 *
 * [출력 대상]
 * - Updates session store with pruned completed/failed/checkpoints.
 *
 * [입력 파라미터]
 * - sessionId (string)
 * - targetAgent (string)
 *
 * [반환값]
 * - Promise<object>
 *
 * [에러 처리]
 * - Throws PentestError if session or checkpoint missing.
 */
export const rollbackToAgent = async (sessionId, targetAgent) => {
  const session = await getSession(sessionId);
  if (!session) {
    throw new PentestError(`Session ${sessionId} not found`, 'validation', false);
  }

  validateAgent(targetAgent);

  if (!session.checkpoints[targetAgent]) {
    throw new PentestError(
      `No checkpoint found for agent '${targetAgent}' in session history`,
      'validation',
      false,
      { targetAgent, availableCheckpoints: Object.keys(session.checkpoints) }
    );
  }

  // Find agents that need to be removed (those after the target agent)
  const targetOrder = AGENTS[targetAgent].order;
  const agentsToRemove = Object.values(AGENTS)
    .filter(agent => agent.order > targetOrder)
    .map(agent => agent.name);

  const updates = {
    completedAgents: session.completedAgents.filter(agent => !agentsToRemove.includes(agent)),
    failedAgents: session.failedAgents.filter(agent => !agentsToRemove.includes(agent)),
    checkpoints: Object.fromEntries(
      Object.entries(session.checkpoints).filter(([agent]) => !agentsToRemove.includes(agent))
    )
  };

  // NOTE: Timing and cost data now managed in audit-logs/session.json
  // Rollback will be reflected via reconcileSession() which marks agents as "rolled-back"

  return await updateSession(sessionId, updates);
};

/**
 * Reconcile DokodemoDoor store with audit logs (self-healing)
 *
 * This function ensures the DokodemoDoor store (.dokodemodoor-store.json) is consistent with
 * the audit logs (audit-logs/session.json) by syncing agent completion status.
 *
 * Three-part reconciliation:
 * 1. PROMOTIONS: Agents completed/failed in audit → added to DokodemoDoor store
 * 2. DEMOTIONS: Agents rolled-back in audit → removed from DokodemoDoor store
 * 3. VERIFICATION: Ensure audit state fully reflected in orchestration
 *
 * Critical for crash recovery, especially crash during rollback operations.
 *
 * @param {string} sessionId - Session ID to reconcile
 * @returns {Promise<Object>} Reconciliation report with added/removed/failed agents
 */
/**
 * [목적] 크래시/롤백 이후 세션 저장소와 감사 로그를 동기화.
 *
 * [호출자]
 * - CLI reconcile command.
 *
 * [출력 대상]
 * - Returns a reconciliation report object.
 *
 * [입력 파라미터]
 * - sessionId (string)
 *
 * [반환값]
 * - Promise<object>
 *
 * [부작용]
 * - Updates session store by promoting/demoting agents.
 */
export const reconcileSession = async (sessionId, options = {}) => {
  const { includeStaleRunning = true } = options;
  const { AuditSession } = await import('./audit/index.js');
  const STALE_AGENT_THRESHOLD_MS = 1000 * 60 * 30; // 30 minutes

  // Get DokodemoDoor store session
  const dokodemodoorSession = await getSession(sessionId);
  if (!dokodemodoorSession) {
    throw new PentestError(`Session ${sessionId} not found in DokodemoDoor store`, 'validation', false);
  }

  // Get audit session data
  const auditSession = new AuditSession(dokodemodoorSession);
  await auditSession.initialize();
  const auditData = await auditSession.getMetrics();

  const report = {
    promotions: [],
    demotions: [],
    failures: []
  };

  // PART 1: PROMOTIONS (Additive)
  // Find agents completed in audit but not in DokodemoDoor store
  const auditCompleted = Object.entries(auditData.metrics.agents)
    .filter(([_, agentData]) => agentData.status === 'success')
    .map(([agentName]) => agentName);

  const missing = auditCompleted.filter(agent => !dokodemodoorSession.completedAgents.includes(agent));

  for (const agentName of missing) {
    const agentData = auditData.metrics.agents[agentName];
    const checkpoint = agentData.checkpoint || null;
    await markAgentCompleted(sessionId, agentName, checkpoint);
    report.promotions.push(agentName);
  }

  // PART 2: DEMOTIONS (Subtractive) - CRITICAL FOR ROLLBACK RECOVERY
  // Find agents rolled-back in audit but still in DokodemoDoor store
  const auditRolledBack = Object.entries(auditData.metrics.agents)
    .filter(([_, agentData]) => agentData.status === 'rolled-back')
    .map(([agentName]) => agentName);

  const toRemove = dokodemodoorSession.completedAgents.filter(agent => auditRolledBack.includes(agent));

  if (toRemove.length > 0) {
    // Reload session to get fresh state
    const freshSession = await getSession(sessionId);

    const updates = {
      completedAgents: freshSession.completedAgents.filter(agent => !toRemove.includes(agent)),
      checkpoints: Object.fromEntries(
        Object.entries(freshSession.checkpoints).filter(([agent]) => !toRemove.includes(agent))
      )
    };

    await updateSession(sessionId, updates);
    report.demotions.push(...toRemove);
  }

  // PART 3: FAILURES
  // Find agents failed in audit but not marked failed in DokodemoDoor store
  const auditFailed = Object.entries(auditData.metrics.agents)
    .filter(([_, agentData]) => agentData.status === 'failed')
    .map(([agentName]) => agentName);

  const failedToAdd = auditFailed.filter(agent => !dokodemodoorSession.failedAgents.includes(agent));

  for (const agentName of failedToAdd) {
    await markAgentFailed(sessionId, agentName);
    report.failures.push(agentName);
  }

  if (includeStaleRunning) {
    // PART 4: STALE RUNNING AGENTS
    // If an agent is still marked running but has no recent activity, mark it failed.
    const runningAgents = dokodemodoorSession.runningAgents || [];
    const now = Date.now();
    for (const agentName of runningAgents) {
      if (dokodemodoorSession.failedAgents.includes(agentName)) continue;
      const agentData = auditData.metrics.agents?.[agentName];
      const lastAttempt = agentData?.attempts?.[agentData.attempts.length - 1];
      const lastTimestamp = lastAttempt?.timestamp ? new Date(lastAttempt.timestamp).getTime() : null;
      const isStale = !lastTimestamp || (now - lastTimestamp) > STALE_AGENT_THRESHOLD_MS;

      if (isStale) {
        await markAgentFailed(sessionId, agentName);
        report.failures.push(agentName);
      }
    }
  }

  return report;
};

// Delete a specific session by ID
/**
 * [목적] 단일 세션 및 산출물 삭제.
 *
 * [호출자]
 * - CLI delete-session command.
 *
 * [출력 대상]
 * - Updates store and deletes deliverables/audit/logs for the session.
 *
 * [입력 파라미터]
 * - sessionId (string)
 *
 * [반환값]
 * - Promise<object>: deleted session data.
 *
 * [부작용]
 * - Filesystem cleanup of session artifacts.
 */
export const deleteSession = async (sessionId) => {
  const store = await loadSessions();

  if (!store.sessions[sessionId]) {
    throw new PentestError(
      `Session ${sessionId} not found`,
      'validation',
      false,
      { sessionId }
    );
  }

  const deletedSession = store.sessions[sessionId];

  // Physical cleanup of session artifacts
  try {
    await cleanupSessionArtifacts(deletedSession);
  } catch (cleanupError) {
    console.log(chalk.yellow(`⚠️ Partial cleanup for session ${sessionId}: ${cleanupError.message}`));
  }

  delete store.sessions[sessionId];
  await saveSessions(store);

  return deletedSession;
};

// Delete all sessions (remove entire storage)
/**
 * [목적] 모든 세션 및 산출물 삭제.
 *
 * [호출자]
 * - CLI delete-all command.
 *
 * [출력 대상]
 * - Deletes store file and related artifacts.
 *
 * [반환값]
 * - Promise<boolean>: whether any sessions existed.
 *
 * [부작용]
 * - Filesystem deletion of logs and deliverables.
 *
 * [에러 처리]
 * - Throws PentestError on filesystem failures.
 */
export const deleteAllSessions = async () => {
  try {
    const store = await loadSessions();
    const sessions = Object.values(store.sessions || {});

    if (sessions.length > 0) {
      for (const session of sessions) {
        try {
          await cleanupSessionArtifacts(session);
        } catch (cleanupError) {
          console.log(chalk.yellow(`⚠️ Partial cleanup for session ${session.id}: ${cleanupError.message}`));
        }
      }
    } else {
      await cleanupOrphanArtifacts();
    }

    if (await fs.pathExists(STORE_FILE)) {
      await fs.remove(STORE_FILE);
      return sessions.length > 0;
    }
    return sessions.length > 0;
  } catch (error) {
    throw new PentestError(
      `Failed to delete session storage: ${error.message}`,
      'filesystem',
      false,
      { storeFile: STORE_FILE, originalError: error.message }
    );
  }
};

/**
 * [목적] 단일 세션의 산출물 삭제.
 *
 * [호출자]
 * - deleteSession(), deleteAllSessions().
 *
 * [출력 대상]
 * - Removes deliverables, outputs, agent logs, and audit logs.
 *
 * [입력 파라미터]
 * - session (object)
 *
 * [반환값]
 * - Promise<void>
 */
const cleanupSessionArtifacts = async (session) => {
  const targetRepo = session.targetRepo || session.repoPath;
  if (targetRepo) {
    const deliverablesPath = path.join(targetRepo, 'deliverables');
    const outputsPath = path.join(targetRepo, 'outputs');

    if (await fs.pathExists(deliverablesPath)) {
      await fs.remove(deliverablesPath);
    }
    if (await fs.pathExists(outputsPath)) {
      await fs.remove(outputsPath);
    }
  }

  const sessionLogPath = generateSessionLogPath(session.webUrl, session.id);
  if (await fs.pathExists(sessionLogPath)) {
    await fs.remove(sessionLogPath);
  }

  const auditLogPath = generateAuditPath(session);
  if (await fs.pathExists(auditLogPath)) {
    await fs.remove(auditLogPath);
  }
};

/**
 * [목적] 세션이 없을 때 산출물 정리.
 *
 * [호출자]
 * - deleteAllSessions() when store is empty.
 *
 * [출력 대상]
 * - Removes audit-logs and deliverables/outputs under repos/.
 *
 * [반환값]
 * - Promise<void>
 */
const cleanupOrphanArtifacts = async () => {
  const rootDir = process.cwd();


  const auditLogsPath = path.join(rootDir, 'audit-logs');
  if (await fs.pathExists(auditLogsPath)) {
    await fs.remove(auditLogsPath);
  }

  const reposPath = path.join(rootDir, 'repos');
  if (await fs.pathExists(reposPath)) {
    const entries = await fs.readdir(reposPath);
    for (const entry of entries) {
      const repoDir = path.join(reposPath, entry);
      const deliverablesPath = path.join(repoDir, 'deliverables');
      const outputsPath = path.join(repoDir, 'outputs');
      if (await fs.pathExists(deliverablesPath)) {
        await fs.remove(deliverablesPath);
      }
      if (await fs.pathExists(outputsPath)) {
        await fs.remove(outputsPath);
      }
    }
  }
};
