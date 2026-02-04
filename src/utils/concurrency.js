/**
 * Concurrency Control Utilities
 *
 * Provides mutex implementation for preventing race conditions during
 * concurrent session operations.
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
