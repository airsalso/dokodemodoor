const DEVELOPER_COMMANDS = Object.freeze([
  '--run-phase',
  '--run-all',
  '--rollback-to',
  '--rerun',
  '--status',
  '--list-agents',
  '--cleanup'
]);

const SETUP_ONLY_FLAG = '--setup-only';

const HELP_FLAGS = new Set(['--help', '-h', 'help']);

/**
 * [목적] CLI 인자가 플래그인지 판별.
 *
 * [호출자]
 * - parseCliArgs()
 *
 * [출력 대상]
 * - boolean 반환
 */
const isFlag = (value) => value.startsWith('-');

/**
 * [목적] CLI 인자를 파싱하여 실행 옵션 구조로 변환.
 *
 * [호출자]
 * - dokodemodoor.mjs 엔트리포인트
 *
 * [출력 대상]
 * - parsed 객체 반환 (config, 세션, 명령 등)
 *
 * [입력 파라미터]
 * - args (array)
 * - defaultDisableLoader (boolean)
 *
 * [반환값]
 * - object
 */
export const parseCliArgs = (args, { defaultDisableLoader } = {}) => {
  const parsed = {
    configPath: null,
    sessionId: null,
    disableLoader: Boolean(defaultDisableLoader),
    setupOnly: false,
    developerCommand: null,
    nonFlagArgs: [],
    showHelp: args.some(arg => HELP_FLAGS.has(arg)),
    error: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--config') {
      if (i + 1 >= args.length) {
        parsed.error = '❌ --config flag requires a file path';
        break;
      }
      parsed.configPath = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--session') {
      if (i + 1 >= args.length) {
        parsed.error = '❌ --session flag requires a session ID';
        break;
      }
      parsed.sessionId = args[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--disable-loader') {
      parsed.disableLoader = true;
      continue;
    }

    if (arg === SETUP_ONLY_FLAG) {
      parsed.setupOnly = true;
      continue;
    }

    if (DEVELOPER_COMMANDS.includes(arg)) {
      parsed.developerCommand = arg;
      const remainingArgs = args.slice(i + 1);

      for (let j = 0; j < remainingArgs.length; j++) {
        const remainingArg = remainingArgs[j];

        if (remainingArg === '--session') {
          if (j + 1 >= remainingArgs.length) {
            parsed.error = '❌ --session flag requires a session ID';
            break;
          }
          parsed.sessionId = remainingArgs[j + 1];
          j += 1;
          continue;
        }

        if (remainingArg === '--disable-loader') {
          parsed.disableLoader = true;
          continue;
        }

        if (remainingArg === SETUP_ONLY_FLAG) {
          parsed.setupOnly = true;
          continue;
        }

        if (!isFlag(remainingArg)) {
          parsed.nonFlagArgs.push(remainingArg);
        }
      }

      break;
    }

    if (!isFlag(arg)) {
      parsed.nonFlagArgs.push(arg);
    }
  }

  return parsed;
};
