/**
 * Time Utilities
 */

/**
 * [목적] 로컬 타임존 ISO 8601 문자열 반환.
 *
 * [호출자]
 * - 로그/감사 기록 전반
 */
export function getLocalISOString(dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const tzOffset = date.getTimezoneOffset() * 60000; // offset in milliseconds
  const localDate = new Date(date.getTime() - tzOffset);
  const iso = localDate.toISOString();

  const offset = -date.getTimezoneOffset();
  const diff = offset >= 0 ? '+' : '-';
  const pad = (num) => Math.floor(Math.abs(num)).toString().padStart(2, '0');
  const timezoneSub = diff + pad(offset / 60) + ':' + pad(offset % 60);

  return iso.slice(0, -1) + timezoneSub;
}

/**
 * [목적] 로그용 가독성 좋은 현지 시간 문자열 반환 (YYYY-MM-DD HH:mm:ss)
 */
export function getLogTimestamp(dateInput = new Date()) {
  const iso = getLocalISOString(dateInput);
  return iso.replace('T', ' ').split('.')[0];
}
