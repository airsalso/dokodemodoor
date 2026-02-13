/**
 * Concurrency Control Utilities
 *
 * Provides mutex and semaphore implementations for preventing race conditions
 * and controlling parallelism during concurrent session operations.
 */

/**
 * SessionMutex - Promise-based mutex for session file operations
 *
 * Prevents race conditions when multiple agents or operations attempt to
 * modify the same session data simultaneously. This is particularly important
 * during parallel execution of vulnerability analysis and exploitation phases.
 *
 * Usage:
 * ```js
 * const mutex = new SessionMutex();
 * const unlock = await mutex.lock(sessionId);
 * try {
 *   // Critical section - modify session data
 * } finally {
 *   unlock(); // Always release the lock
 * }
 * ```
 */
/**
 * Semaphore - 동시 실행 수를 제어하는 세마포어.
 *
 * chunk 방식과 달리, 슬롯이 비는 즉시 다음 작업을 시작하므로
 * 느린 에이전트가 다른 에이전트를 blocking하지 않습니다.
 *
 * Usage:
 * ```js
 * const sem = new Semaphore(3); // max 3 concurrent
 * const results = await sem.map(items, async (item) => { ... });
 * ```
 */
export class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.running = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.running < this.limit) {
      this.running++;
      return;
    }
    // Wait for a slot to open
    await new Promise(resolve => this.queue.push(resolve));
  }

  release() {
    this.running--;
    if (this.queue.length > 0) {
      this.running++;
      const next = this.queue.shift();
      next();
    }
  }

  /**
   * [목적] 배열의 각 요소에 대해 최대 limit 개까지 동시 실행하고 결과를 Promise.allSettled 형태로 반환.
   *
   * [특성]
   * - 에이전트 A가 완료되면 즉시 다음 대기 에이전트가 시작됨 (chunk blocking 없음)
   * - 결과 순서는 입력 배열 순서와 동일하게 유지됨
   *
   * @param {Array} items - 작업 대상 배열
   * @param {Function} fn - async 실행 함수 (item) => result
   * @returns {Promise<Array>} Promise.allSettled 형태의 결과 배열
   */
  async map(items, fn) {
    const results = items.map(async (item) => {
      await this.acquire();
      try {
        const value = await fn(item);
        return { status: 'fulfilled', value };
      } catch (reason) {
        return { status: 'rejected', reason };
      } finally {
        this.release();
      }
    });
    return Promise.all(results);
  }
}

export class SessionMutex {
  constructor() {
    // Map of sessionId -> Promise (represents active lock)
    this.locks = new Map();
  }

  /**
   * Acquire lock for a session
   * @param {string} sessionId - Session ID to lock
   * @returns {Promise<Function>} Unlock function to release the lock
   */
  /**
   * [목적] 세션 단위 락 획득.
   *
   * [호출자]
   * - session-manager, audit-session
   */
  async lock(sessionId) {
    // Get existing lock promise or a resolved one
    const previousLock = this.locks.get(sessionId) || Promise.resolve();

    // Create a new promise for the next in line
    let resolveNext;
    const nextLock = new Promise(resolve => {
      resolveNext = resolve;
    });

    // Set as the current lock immediately (synchronous part)
    this.locks.set(sessionId, nextLock);

    // Wait for the previous lock to finish
    try {
      await previousLock;
    } catch (e) {
      // Ignore errors in previous locks; they should have been handled
    }

    // Return unlock function
    return () => {
      // Resolve the next waiter in line
      resolveNext();

      // Clear the lock entry only if we are still the current lock
      if (this.locks.get(sessionId) === nextLock) {
        this.locks.delete(sessionId);
      }
    };
  }
}
