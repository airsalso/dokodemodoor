import { $ } from 'zx';
import chalk from 'chalk';

// Check availability of required tools
/**
 * [목적] 외부 도구 설치 여부 확인.
 *
 * [호출자]
 * - dokodemodoor.mjs 초기 실행
 *
 * [반환값]
 * - Promise<object>
 */
export const checkToolAvailability = async (mode = 'web') => {
  // Check if tool check should be skipped
  const { config } = await import('./config/env.js').catch(() => ({ config: null }));

  if (config?.dokodemodoor?.skipToolCheck) {
    console.log(chalk.blue('🔧 Skipping tool availability check (DOKODEMODOOR_SKIP_TOOL_CHECK=true)'));
    return { nmap: true, subfinder: true, whatweb: true, schemathesis: true, semgrep: true, sqlmap: true, curl: true, git: true };
  }

  // Categories of tools
  const isLinux = process.platform === 'linux';
  const toolChain = mode === 're' ? {
    infrastructure: ['git'],
    're-inventory': isLinux ? ['file', 'readelf', 'diec'] : ['sigcheck64', 'diec'],
    're-static': ['analyzeHeadless']
  } : {
    infrastructure: ['git', 'curl'],
    reconnaissance: ['nmap', 'subfinder', 'whatweb'],
    analysis: ['semgrep', 'schemathesis', 'rg'],
    exploitation: ['sqlmap']
  };

  const allTools = Object.values(toolChain).flat();
  const availability = {};

  console.log(chalk.blue.bold('\n🔧 CHECKING SECURITY TOOLCHAIN AVAILABILITY...'));

  for (const tool of allTools) {
    try {
      await $`command -v ${tool}`;
      availability[tool] = true;
      console.log(chalk.green(`  ✅ ${tool.padEnd(15)} - available`));
    } catch {
      availability[tool] = false;
      console.log(chalk.red(`  ❌ ${tool.padEnd(15)} - NOT FOUND`));
    }
  }

  return availability;
};

// Handle missing tools with user-friendly messages
/**
 * [목적] 누락 도구 안내 및 가이드 출력.
 */
export const handleMissingTools = (toolAvailability) => {
  const missing = Object.entries(toolAvailability)
    .filter(([tool, available]) => !available)
    .map(([tool]) => tool);

  if (missing.length > 0) {
    console.log(chalk.red.bold('\n🚨 CRITICAL WARNING: MISSING TOOLS DETECTED'));
    console.log(chalk.yellow('   The following security tools were not found in your system PATH.'));
    console.log(chalk.yellow('   Without these, the quality of the pentest will be significantly degraded.'));

    // Provide installation hints
    const installHints = {
      'git': 'sudo apt install git',
      'curl': 'sudo apt install curl',
      'nmap': 'sudo apt install nmap',
      'subfinder': 'go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest',
      'whatweb': 'sudo apt install whatweb',
      'semgrep': 'python3 -m pip install semgrep',
      'schemathesis': 'pip install schemathesis',
      'sqlmap': 'pip install sqlmap',
      'rg': 'sudo apt install ripgrep',
      'file': 'sudo apt install file',
      'readelf': 'sudo apt install binutils',
      'diec': 'Detect It Easy CLI: https://github.com/horsicq/DIE-engine/releases',
      'analyzeHeadless': 'Ghidra: https://ghidra-sre.org/ (set GHIDRA_HOME env var)',
      'sigcheck64': 'Windows Sysinternals: https://learn.microsoft.com/en-us/sysinternals/downloads/sigcheck'
    };

    console.log(chalk.white('\n📋 INSTALLATION GUIDE:'));
    missing.forEach(tool => {
      const hint = installHints[tool] || 'Check official documentation';
      console.log(`${chalk.red('  •')} ${chalk.bold(tool.padEnd(12))} : ${chalk.gray(hint)}`);
    });

    // Check for essential tools
    const essentialMissing = missing.filter(t => ['git', 'curl', 'semgrep'].includes(t));
    if (essentialMissing.length > 0) {
      console.log(chalk.red.bold('\n🛑 WARNING: Essential tools are missing!'));
      console.log(chalk.red('   Analysis and recovery features may not work correctly until installed.'));
    }
    console.log('');
  }

  return missing;
};
