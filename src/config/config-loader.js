import { fs, path } from 'zx';
import { parseConfig, distributeConfig } from '../config-parser.js';

/**
 * [목적] 상대 경로/기본 configs 디렉토리를 고려해 설정 파일 경로를 해석.
 *
 * [호출자]
 * - loadConfig()
 * - dokodemodoor.mjs 설정 로딩 경로
 *
 * [출력 대상]
 * - 실제 설정 파일 경로 반환
 *
 * [입력 파라미터]
 * - configPath (string|null)
 * - cwd (string)
 *
 * [반환값]
 * - Promise<string|null>
 */
export const resolveConfigPath = async (configPath, cwd = process.cwd()) => {
  if (!configPath) {
    return null;
  }

  if (path.isAbsolute(configPath)) {
    return configPath;
  }

  const configsDir = path.join(cwd, 'configs');
  const configInConfigsDir = path.join(configsDir, configPath);
  if (await fs.pathExists(configInConfigsDir)) {
    return configInConfigsDir;
  }

  return configPath;
};

/**
 * [목적] 설정 파일을 읽고 분산(Agent용) 설정을 생성.
 *
 * [호출자]
 * - dokodemodoor.mjs, checkpoint-manager.js
 *
 * [출력 대상]
 * - { config, distributedConfig, resolvedConfigPath } 반환
 *
 * [입력 파라미터]
 * - configPath (string|null)
 *
 * [반환값]
 * - Promise<object>
 */
export const loadConfig = async (configPath) => {
  if (!configPath) {
    return { config: null, distributedConfig: null, resolvedConfigPath: null };
  }

  const resolvedConfigPath = await resolveConfigPath(configPath);
  const config = await parseConfig(resolvedConfigPath);
  const distributedConfig = distributeConfig(config);

  return { config, distributedConfig, resolvedConfigPath };
};
