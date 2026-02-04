import chalk from 'chalk';

export class ProgressIndicator {
  constructor(message = 'Working...') {
    this.message = message;
    this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.frameIndex = 0;
    this.interval = null;
    this.isRunning = false;
  }

  /**
   * [목적] 스피너 시작.
   *
   * [호출자]
   * - agent-executor (clean output 모드)
   */
  start() {
    if (this.isRunning) return;

    this.isRunning = true;
    this.frameIndex = 0;

    this.interval = setInterval(() => {
      // Clear the line and write the spinner
      process.stdout.write(`\r${chalk.cyan(this.frames[this.frameIndex])} ${chalk.dim(this.message)}`);
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
    }, 100);
  }

  /**
   * [목적] 스피너 중지 및 라인 정리.
   *
   * [호출자]
   * - agent-executor
   */
  stop() {
    if (!this.isRunning) return;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    // Clear the spinner line
    process.stdout.write('\r' + ' '.repeat(this.message.length + 5) + '\r');
    this.isRunning = false;
  }

  /**
   * [목적] 스피너 종료 및 완료 메시지 출력.
   *
   * [호출자]
   * - agent-executor
   */
  finish(successMessage = 'Complete') {
    this.stop();
    console.log(chalk.green(`✓ ${successMessage}`));
  }
}
