// Calendar days, the same on the server and in the browser. Deadlines are days ("overdue" means: before today), and
// today is the day in the instance's time zone (TIME_ZONE, default Europe/Berlin) – not the UTC date, which just after
// midnight is still yesterday's. Built from parts, so it does not depend on a locale's date format.
export const DEFAULT_ZONE = 'Europe/Berlin';

export function localDay(ms, timeZone = DEFAULT_ZONE) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(ms).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// A day plus n days (calendar arithmetic on YYYY-MM-DD, no time of day involved).
export const addDays = (day, n) => new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);
