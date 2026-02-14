/**
 * File-based Lock for Cross-process Synchronization
 *
 * 여러 Node.js 프로세스가 동시에 동일한 파일(세션 스토어 등)에 접근할 때
 * 원자적 파일 생성(O_CREAT | O_EXCL)을 이용한 상호 배제를 제공합니다.
 *
 * [특성]
 * - O_CREAT | O_EXCL 를 통한 커널 수준 원자적 락 획득
 * - PID + 타임스탬프 기반 stale lock 자동 감지/정리
 * - 프로세스 비정상 종료 시 exit 핸들러를 통한 자동 정리
 * - jitter가 포함된 재시도로 thundering herd 방지
 */

import { open, unlink, readFile } from 'node:fs/promises';
import { constants, unlinkSync } from 'node:fs';

/**
 * [목적] 파일 기반 프로세스 간 상호 배제 락.
 *
 * [호출자]
 * - session-manager.js (세션 스토어 파일 보호)
 *
 * Usage:
 * ```js
 * const lock = new FileLock('/path/to/store.json.lock');
 *
 * // 방법 1: withLock (권장)
 * const result = await lock.withLock(async () => {
 *   const data = await readJSON(storePath);
 *   data.foo = 'bar';
 *   await writeJSON(storePath, data);
 *   return data;
 * });
 *
 * // 방법 2: 수동 acquire/release
 * await lock.acquire();
 * try { ... } finally { await lock.release(); }
 * ```
 */
export class FileLock {
  /**
   * @param {string} lockPath - 락 파일 경로 (e.g., '/path/to/store.json.lock')
   * @param {Object} [options]
   * @param {number} [options.staleMs=30000] - 이 시간(ms) 이상 유지된 락은 stale로 간주
   * @param {number} [options.retryIntervalMs=50] - 기본 재시도 간격 (ms), jitter 추가됨
   * @param {number} [options.timeoutMs=10000] - 락 획득 타임아웃 (ms)
   */
  constructor(lockPath, { staleMs = 30000, retryIntervalMs = 50, timeoutMs = 10000 } = {}) {
    this.lockPath = lockPath;
    this.staleMs = staleMs;
    this.retryIntervalMs = retryIntervalMs;
    this.timeoutMs = timeoutMs;
    this._held = false;
    this._cleanupHandler = null;
  }

  /**
   * [목적] 락 획득. 이미 다른 프로세스/스레드가 보유 시 재시도.
   *
   * @returns {Promise<void>}
   * @throws {Error} 타임아웃 초과 시
   */
  async acquire() {
    const start = Date.now();

    while (true) {
      try {
        // Atomic: O_CREAT | O_EXCL 조합은 파일이 이미 존재하면 EEXIST 에러 발생
        // 커널 수준에서 원자적으로 처리되므로 race condition 없음
        const fd = await open(
          this.lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
        );
        const lockInfo = JSON.stringify({ pid: process.pid, time: Date.now() });
        await fd.writeFile(lockInfo);
        await fd.close();

        this._held = true;
        this._registerCleanup();
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;

        // 락 파일이 존재 — stale 여부 확인
        if (await this._isStale()) {
          await unlink(this.lockPath).catch(() => {});
          continue; // 즉시 재시도
        }

        // 타임아웃 확인
        if (Date.now() - start >= this.timeoutMs) {
          throw new Error(
            `File lock acquisition timed out after ${this.timeoutMs}ms: ${this.lockPath}`
          );
        }

        // jitter를 포함한 대기 (thundering herd 방지)
        const jitter = Math.random() * this.retryIntervalMs;
        await new Promise(r => setTimeout(r, this.retryIntervalMs + jitter));
      }
    }
  }

  /**
   * [목적] 락 해제.
   *
   * @returns {Promise<void>}
   */
  async release() {
    if (!this._held) return;
    this._held = false;
    this._unregisterCleanup();
    await unlink(this.lockPath).catch(() => {});
  }

  /**
   * [목적] 락을 보유한 상태에서 함수 실행 후 자동 해제.
   *
   * @param {Function} fn - 실행할 비동기 함수
   * @returns {Promise<*>} fn의 반환값
   */
  async withLock(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }

  /**
   * [목적] 락 파일이 stale(죽은 프로세스 또는 시간 초과)인지 확인.
   *
   * @returns {Promise<boolean>}
   * @private
   */
  async _isStale() {
    try {
      const content = await readFile(this.lockPath, 'utf8');

      // 빈 파일 또는 불완전한 내용 — 다른 프로세스가 아직 쓰기 중일 수 있음
      // 즉시 stale로 판단하지 않고 false를 반환하여 재시도 루프로 대기
      if (!content || content.trim().length === 0) {
        return false;
      }

      let lockInfo;
      try {
        lockInfo = JSON.parse(content);
      } catch {
        // JSON 파싱 실패 — 쓰기 진행 중 (partial write)으로 간주
        // stale이 아닌 "사용 중"으로 처리하여 재시도 대기
        return false;
      }

      // 시간 기반 stale 판단
      if (Date.now() - lockInfo.time > this.staleMs) {
        return true;
      }

      // PID 기반 stale 판단 (프로세스가 죽었는지 확인)
      if (lockInfo.pid && !this._isProcessAlive(lockInfo.pid)) {
        return true;
      }

      return false;
    } catch {
      // 락 파일 자체를 읽을 수 없으면 (ENOENT 등) stale로 간주
      return true;
    }
  }

  /**
   * [목적] PID가 살아있는 프로세스인지 확인.
   *
   * @param {number} pid
   * @returns {boolean}
   * @private
   */
  _isProcessAlive(pid) {
    try {
      process.kill(pid, 0); // Signal 0: 존재 여부만 확인 (실제 시그널 전송 안 함)
      return true;
    } catch {
      return false;
    }
  }

  /**
   * [목적] 프로세스 비정상 종료 시 락 파일 정리 핸들러 등록.
   *
   * process 'exit' 이벤트에서는 비동기 작업이 불가하므로
   * 동기 unlinkSync를 사용합니다.
   *
   * @private
   */
  _registerCleanup() {
    this._cleanupHandler = () => {
      try {
        unlinkSync(this.lockPath);
      } catch {
        // 이미 삭제되었거나 접근 불가 — 무시
      }
    };
    process.on('exit', this._cleanupHandler);
  }

  /**
   * [목적] 정상 락 해제 후 exit 핸들러 제거.
   *
   * @private
   */
  _unregisterCleanup() {
    if (this._cleanupHandler) {
      process.removeListener('exit', this._cleanupHandler);
      this._cleanupHandler = null;
    }
  }
}
