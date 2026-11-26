// Day boundaries for statistics: Asia/Shanghai (UTC+8, no DST) midnight.
// A session belongs entirely to the Beijing date it started.
const OFFSET_MS = 8 * 3600 * 1000, DAY_MS = 86400000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const beijingDay = ms => new Date(ms + OFFSET_MS).toISOString().slice(0, 10);
export const isDay = value => typeof value === 'string' && DAY.test(value) && Number.isFinite(dayStart(value)) && beijingDay(dayStart(value)) === value;
export const dayStart = day => Date.parse(day + 'T00:00:00Z') - OFFSET_MS;  // epoch ms of Beijing 00:00
export const addDays = (day, n) => beijingDay(dayStart(day) + n * DAY_MS);
export function daysBetween(from, to) {
  const out = [];
  for (let day = from; day <= to; day = addDays(day, 1)) out.push(day);
  return out;
}
