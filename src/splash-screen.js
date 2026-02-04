import figlet from 'figlet';
import gradient from 'gradient-string';
import boxen from 'boxen';
import chalk from 'chalk';
import { fs, path } from 'zx';

/**
 * [목적] CLI 시작 화면(아스키/로딩) 표시.
 *
 * [호출자]
 * - dokodemodoor.mjs
 *
 * [반환값]
 * - Promise<void>
 */
export const displaySplashScreen = async () => {
  try {
    // Get version info from package.json
    const packagePath = path.join(import.meta.dirname, '..', 'package.json');
    const packageJson = await fs.readJSON(packagePath);
    const version = packageJson.version || '1.0.0';

    // Create the main ASCII art with a 3D filled look
    const doorText = figlet.textSync('DOKODEMO DOOR', {
      font: 'ANSI Shadow',
      horizontalLayout: 'default',
      verticalLayout: 'default'
    });

    // Create side‑by‑side Door and Doraemon ASCII art
    const doorLines = [
      '                        _________________',
      '                        |  ___________  | |',
      '                        | |           | | |',
      '                        | |  D o k o  | | |',
      '                        | |  D e m o  | | |',
      '                        | |  D o o r  | | |',
      '                        | |           | | |',
      '                        | |         @ | | |',
      '                        | |     _     | | |',
      '                        | |    (_)    | | |',
      '                        | |           | | |',
      '                        | |___________| | |',
      '                        |_______________|/',
    ];
    const doraemonLines = [
      '                  _.-"""""-._',
      '                ."  _     _  ".',
      '               /   (0)   (0)   \\',
      '              |         o       |',
      '              |      = (_) =    |',
      '               \\               /',
      '                `-._________.-`',
      '                 /`    0    `\\',
      '                (   (     )   )',
      '                 \\  `---`   /',
      '                  |__     __|',
      '                  (   ) (   )',
      '                   `"`   `"`'
    ];
    // Color the Door lines (Magenta/Pink)
    const coloredDoorLines = doorLines.map(line => chalk.magenta(line));

    // Color the Doraemon lines (Blue/Cyan with special colors for nose/bell)
    const coloredDoraemonLines = doraemonLines.map((line, index) => {
      let coloredLine = chalk.cyan(line);

      // Detailed coloring for Doraemon's features
      if (index === 3) { // Nose line: |         o       |
        coloredLine = coloredLine.replace('o', chalk.red.bold('●'));
      }
      if (index === 6) { // Collar/Collar bottom
        coloredLine = coloredLine.replace('_________', chalk.red.bold('_________'));
      }
      if (index === 7) { // Collar line: (   (  o  )   )
        coloredLine = coloredLine.replace('0', chalk.yellow('0'));
      }

      return coloredLine;
    });

    // Pad shorter array with empty strings (already color-aware)
    const maxLines = Math.max(coloredDoorLines.length, coloredDoraemonLines.length);
    const paddedDoor = coloredDoorLines.concat(Array(maxLines - coloredDoorLines.length).fill(''));
    const paddedDoraemon = coloredDoraemonLines.concat(Array(maxLines - coloredDoraemonLines.length).fill(''));

    const logoLines = paddedDoor.map((dl, i) => dl + '   ' + paddedDoraemon[i]);
    const logoContent = logoLines.join('\n');

    // Apply colored gradient to the Door text (Doraemon Blue)
    const gradientDoor = gradient(['#00BFFF', '#1E90FF', '#4169E1'])(doorText);
    const finalLogo = logoContent; // Already colored line by line

    // Create tagline with styling
    const tagline = chalk.bold.white('Dokodemo Door: AI Penetration Testing Framework');
    const versionInfo = chalk.gray(`v${version}`);

    // Build the complete splash content
    const content = [
      finalLogo,
      '',
      gradientDoor,
      '',
      chalk.bold.magenta('                         ╔═══════════════════════════════════════════════════╗'),
      chalk.bold.magenta('                         ║') + '  ' + tagline + '  ' + chalk.bold.magenta('║'),
      chalk.bold.magenta('                         ╚═══════════════════════════════════════════════════╝'),
      '',
      `                                               ${versionInfo}`,
      '',
      chalk.bold.yellow('                                 🔐 Cloud Software Security Part 🔐'),
      ''
    ].join('\n');

    // Create boxed output with minimal styling
    const boxedContent = boxen(content, {
      padding: 1,
      margin: 1,
      borderStyle: 'double',
      borderColor: 'cyan',
      dimBorder: false
    });

    // Clear screen and display splash
    console.clear();
    console.log(boxedContent);

    // Add loading animation
    const loadingFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frameIndex = 0;

    return new Promise((resolve) => {
      const loadingInterval = setInterval(() => {
        process.stdout.write(`\r${chalk.cyan(loadingFrames[frameIndex])} ${chalk.dim('Initializing systems...')}`);
        frameIndex = (frameIndex + 1) % loadingFrames.length;
      }, 100);

      setTimeout(() => {
        clearInterval(loadingInterval);
        process.stdout.write(`\r${chalk.green('✓')} ${chalk.dim('Systems initialized.        ')}\n\n`);
        resolve();
      }, 2000);
    });

  } catch (error) {
    // Fallback to simple splash if anything fails
    console.log(chalk.magenta.bold('\n� DOKODEMO DOOR - AI Penetration Testing Framework\n'));
    console.log(chalk.yellow('⚠️  Could not load full splash screen:', error.message));
    console.log('');
  }
};
