export function streak(dates: string[], now = new Date()) {
  const days = [...new Set(dates.map((d) => d.slice(0, 10)))].sort();
  let longest = 0,
    run = 0,
    previous = -Infinity;
  for (const day of days) {
    const n = Date.parse(day) / 86400000;
    run = n === previous + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = n;
  }
  const today = Math.floor(now.getTime() / 86400000);
  return { current: previous >= today - 1 ? run : 0, longest, activeDays: days.length };
}
export function quotaBounds(now: Date) {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const week = new Date(day);
  week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
  return {
    day,
    week,
    nextDay: new Date(+day + 86400000),
    nextWeek: new Date(+week + 7 * 86400000),
  };
}
