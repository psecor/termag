// Pure helpers for research.mjs (the theme-of-the-day skill's research,
// docs/daily-theme.md). No network, no clock: everything takes its date.

export const OAKLAND = { lat: 37.8044, lon: -122.2712, timeZone: 'America/Los_Angeles' };
const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' → [y, m, d], throwing on anything else. */
export function parseDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (!m) throw new Error(`not a YYYY-MM-DD date: ${date}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) throw new Error(`no such date: ${date}`);
  return [y, mo, d];
}

const pad = n => String(n).padStart(2, '0');
export const isoDate = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** A UTC instant as local 'HH:MM' and its zone name, in `timeZone`. */
export function localTime(instant, timeZone = OAKLAND.timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' })
    .formatToParts(instant);
  const get = t => parts.find(p => p.type === t)?.value;
  return `${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
}

/** The calendar date of a UTC instant in `timeZone`. */
export function localDate(instant, timeZone = OAKLAND.timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

// NOAA's solar equations (the Solar Calculator spreadsheet), good to about a
// minute at Oakland's latitude.
function solarAt(jd) {
  const t = (jd - 2451545) / 36525;
  const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const C = Math.sin(M * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * t) + Math.sin(3 * M * RAD) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) / RAD;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTime = 4 / RAD * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD)
    + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
    - 0.5 * y * y * Math.sin(4 * L0 * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD));
  return { decl, eqTime };
}

/** Sunrise, sunset and day length on `date` at `place`, as UTC instants and local times. */
export function sunTimes(date, place = OAKLAND) {
  const [y, m, d] = parseDate(date);
  const midnightUtc = Date.UTC(y, m - 1, d);
  const jd0 = midnightUtc / DAY_MS + 2440587.5;
  const event = rising => {
    // Two passes: the second evaluates the sun at the first estimate's time.
    let minutes = 720 - 4 * place.lon;
    for (let i = 0; i < 2; i++) {
      const { decl, eqTime } = solarAt(jd0 + minutes / 1440);
      const cosH = Math.cos(90.833 * RAD) / (Math.cos(place.lat * RAD) * Math.cos(decl * RAD)) - Math.tan(place.lat * RAD) * Math.tan(decl * RAD);
      if (cosH > 1 || cosH < -1) return null; // no rise or set (polar)
      const ha = Math.acos(cosH) / RAD;
      minutes = 720 - 4 * (place.lon + (rising ? ha : -ha)) - eqTime;
    }
    return new Date(midnightUtc + minutes * 60_000);
  };
  const rise = event(true), set = event(false);
  const len = rise && set ? Math.round((set - rise) / 60_000) : null;
  return {
    sunrise: rise && localTime(rise, place.timeZone),
    sunset: set && localTime(set, place.timeZone),
    dayLength: len == null ? null : `${Math.floor(len / 60)}h ${pad(len % 60)}m`,
    sunriseUtc: rise?.toISOString() ?? null,
    sunsetUtc: set?.toISOString() ?? null,
  };
}

// Meeus, Astronomical Algorithms ch. 27: equinoxes and solstices, with the
// periodic terms, to about a minute.
const SEASON_TERMS = [
  [485, 324.96, 1934.136], [203, 337.23, 32964.467], [199, 342.08, 20.186], [182, 27.85, 445267.112],
  [156, 73.14, 45036.886], [136, 171.52, 22518.443], [77, 222.54, 65928.934], [74, 296.72, 3034.906],
  [70, 243.58, 9037.513], [58, 119.81, 33718.147], [52, 297.17, 150.678], [50, 21.02, 2281.226],
  [45, 247.54, 29929.562], [44, 325.15, 31555.956], [29, 60.93, 4443.417], [18, 155.12, 67555.328],
  [17, 288.79, 4562.452], [16, 198.04, 62894.029], [14, 199.76, 31436.921], [12, 95.39, 14577.848],
  [12, 287.11, 31931.756], [12, 320.81, 34777.259], [9, 227.73, 1222.114], [8, 15.45, 16859.074],
];
const SEASON_MEAN = [
  [2451623.80984, 365242.37404, 0.05169, -0.00411, -0.00057], // March equinox
  [2451716.56767, 365241.62603, 0.00325, 0.00888, -0.00030], // June solstice
  [2451810.21715, 365242.01767, -0.11575, 0.00337, 0.00078], // September equinox
  [2451900.05952, 365242.74049, -0.06223, -0.00823, 0.00032], // December solstice
];
export const SEASON_EVENTS = ['March equinox', 'June solstice', 'September equinox', 'December solstice'];

/** The instant of season event `k` (0 March equinox … 3 December solstice) in `year` (TT ≈ UTC + about a minute). */
export function seasonEvent(year, k) {
  const Y = (year - 2000) / 1000;
  const [a, b, c, d, e] = SEASON_MEAN[k];
  const jde0 = a + b * Y + c * Y ** 2 + d * Y ** 3 + e * Y ** 4;
  const T = (jde0 - 2451545) / 36525;
  const W = 35999.373 * T - 2.47;
  const dl = 1 + 0.0334 * Math.cos(W * RAD) + 0.0007 * Math.cos(2 * W * RAD);
  const S = SEASON_TERMS.reduce((sum, [A, B, C]) => sum + A * Math.cos((B + C * T) * RAD), 0);
  const jde = jde0 + (0.00001 * S) / dl;
  // TT - UTC is about 69 s in the 2020s; close enough for a date and a minute.
  return new Date((jde - 2440587.5) * DAY_MS - 69_000);
}

/** The (northern hemisphere, astronomical) season on `date`, and the next equinox or solstice. */
export function season(date, timeZone = OAKLAND.timeZone) {
  const [y] = parseDate(date);
  const events = [];
  for (const year of [y - 1, y, y + 1]) for (let k = 0; k < 4; k++) events.push({ year, k, at: seasonEvent(year, k) });
  const dayOf = e => localDate(e.at, timeZone);
  const past = events.filter(e => dayOf(e) <= date).at(-1);
  const next = events.find(e => dayOf(e) > date);
  const names = ['spring', 'summer', 'autumn', 'winter'];
  const toDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
  return {
    season: names[past.k],
    startedOn: dayOf(past),
    isStartDay: dayOf(past) === date,
    next: { event: SEASON_EVENTS[next.k], on: dayOf(next), inDays: toDays(date, dayOf(next)) },
  };
}

const SYNODIC = 29.530588853;
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14); // 2000-01-06 18:14 UTC
const PHASE_NAMES = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full moon', 'waning gibbous', 'last quarter', 'waning crescent'];

/** The moon at local noon on `date`: age in days, 0..1 phase (0 new, 0.5 full), illumination and a name. */
export function moonPhase(date, timeZone = OAKLAND.timeZone) {
  const [y, m, d] = parseDate(date);
  // Local noon in Pacific is 19:00 or 20:00 UTC; 20:00 is near enough for a phase.
  const noon = Date.UTC(y, m - 1, d, timeZone === OAKLAND.timeZone ? 20 : 12);
  const age = (((noon - KNOWN_NEW_MOON) / DAY_MS) % SYNODIC + SYNODIC) % SYNODIC;
  const phase = age / SYNODIC;
  const illumination = Math.round(((1 - Math.cos(2 * Math.PI * phase)) / 2) * 100) / 100;
  // Named by the nearest eighth, so "full moon" covers about a day and a half either side.
  const name = PHASE_NAMES[Math.round(phase * 8) % 8];
  return { ageDays: Math.round(age * 10) / 10, phase: Math.round(phase * 1000) / 1000, illumination, name };
}

function nthWeekday(y, m, weekday, n) {
  // n >= 1: the nth; n = -1: the last.
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(y, m, 0));
  return lastDay.getUTCDate() - ((lastDay.getUTCDay() - weekday + 7) % 7);
}

/** US federal holidays and a few widely observed, secular days in `year`: [{ date, name, federal }]. */
export function holidays(year) {
  const MON = 1, THU = 4;
  const list = [
    [1, 1, "New Year's Day", true],
    [1, nthWeekday(year, 1, MON, 3), 'Martin Luther King Jr. Day', true],
    [2, 14, "Valentine's Day", false],
    [2, nthWeekday(year, 2, MON, 3), "Washington's Birthday (Presidents' Day)", true],
    [3, 14, 'Pi Day', false],
    [3, 17, "St. Patrick's Day", false],
    [4, 22, 'Earth Day', false],
    [5, nthWeekday(year, 5, MON, -1), 'Memorial Day', true],
    [6, 19, 'Juneteenth', true],
    [7, 4, 'Independence Day', true],
    [9, nthWeekday(year, 9, MON, 1), 'Labor Day', true],
    [10, nthWeekday(year, 10, MON, 2), "Columbus Day / Indigenous Peoples' Day", true],
    [10, 31, 'Halloween', false],
    [11, 11, 'Veterans Day', true],
    [11, nthWeekday(year, 11, THU, 4), 'Thanksgiving', true],
    [12, 25, 'Christmas Day', true],
    [12, 31, "New Year's Eve", false],
  ];
  return list.map(([m, d, name, federal]) => ({ date: isoDate(year, m, d), name, federal })).sort((a, b) => a.date.localeCompare(b.date));
}

// Text from the web (the NWS forecast, Wikipedia's feed) is read by an agent
// that has a shell, so it goes into the brief only as plain words: no control,
// zero-width or bidi characters, nothing that builds a code fence, a tag, a
// template or a shell expansion (` < > { } [ ] \ $ |), whitespace collapsed,
// and capped. It stays untrusted all the same; the skill says so.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff`<>{}\[\]\\$|]/g;

/** Fetched text made plain (see UNSAFE_CHARS) and cut to `max` characters. */
export function untrustedText(s, max) {
  const t = String(s ?? '').normalize('NFKC').replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
const truncate = untrustedText;

/** A Wikipedia article link from the feed, or null for anything that is not one. */
export function wikipediaUrl(url) {
  return typeof url === 'string' && isAllowedUrl(url) && new URL(url).hostname === 'en.wikipedia.org' ? url : null;
}

/** The NWS forecast periods that start on `date` (their own offset's calendar date), trimmed. */
export function selectForecastPeriods(forecast, date, maxText = 300) {
  const periods = forecast?.properties?.periods;
  if (!Array.isArray(periods)) return [];
  return periods
    .filter(p => typeof p.startTime === 'string' && p.startTime.slice(0, 10) === date)
    .map(p => ({
      name: truncate(p.name, 40),
      isDaytime: p.isDaytime === true,
      temperature: Number.isFinite(p.temperature) ? p.temperature : null,
      temperatureUnit: p.temperatureUnit === 'C' ? 'C' : 'F',
      precipitationChance: Number.isFinite(p.probabilityOfPrecipitation?.value) ? p.probabilityOfPrecipitation.value : null,
      wind: truncate([p.windSpeed, p.windDirection].filter(Boolean).join(' '), 40),
      shortForecast: truncate(p.shortForecast, 120),
      detailedForecast: truncate(p.detailedForecast, maxText),
    }));
}

/** `n` items spread evenly over `items`, first and last included, in order. */
export function spread(items, n) {
  if (items.length <= n) return items.slice();
  if (n <= 1) return items.slice(0, n);
  const picked = [];
  for (let i = 0; i < n; i++) picked.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  return picked;
}

// The feed lists events and births newest first, and the newest are mostly
// news (disasters, elections), which the skill skips; spread over the list,
// the brief reaches back through the centuries. Holidays and the editors'
// selection are short lists, read from the top.
const SPREAD_KINDS = new Set(['events', 'births']);

/** Wikipedia's "on this day" feed, cut down: a few items of each kind, text truncated, one link each. */
export function trimOnThisDay(feed, limits = { events: 8, births: 5, holidays: 6, selected: 5 }, maxText = 220) {
  const out = {};
  for (const [kind, n] of Object.entries(limits)) {
    const items = Array.isArray(feed?.[kind]) ? feed[kind] : [];
    const chosen = SPREAD_KINDS.has(kind) ? spread(items, n) : items.slice(0, n);
    out[kind] = chosen.map(item => {
      const page = Array.isArray(item.pages) ? item.pages[0] : null;
      return {
        ...(Number.isInteger(item.year) ? { year: item.year } : {}),
        text: truncate(item.text, maxText),
        ...(page ? { page: truncate(page.normalizedtitle ?? page.titles?.normalized ?? page.title, 100), url: wikipediaUrl(page.content_urls?.desktop?.page) } : {}),
      };
    });
  }
  return out;
}

// The only hosts research fetches from. A URL taken from a response (the NWS
// points' `forecast` link, a redirect's Location) is followed only when it is
// one of these over https, so a tampered response can't send the run to an
// internal address.
export const ALLOWED_HOSTS = ['api.weather.gov', 'api.wikimedia.org', 'en.wikipedia.org'];

/** Whether `url` (resolved against `base`) is https on an allowed host, with no credentials or port. */
export function isAllowedUrl(url, base) {
  let u;
  try { u = new URL(url, base); } catch { return false; }
  return u.protocol === 'https:' && ALLOWED_HOSTS.includes(u.hostname) && !u.username && !u.password && u.port === '';
}

// What a day's commit may touch: only frontend/src/theme/daily/<YYYY-MM-DD>/,
// and only the three files a day holds (check-diff.mjs runs this on git's list).
const DAY_PATH = /^frontend\/src\/theme\/daily\/\d{4}-\d{2}-\d{2}\/(meta\.json|theme\.css|sprite\.js)$/;

/** The paths in `paths` that a theme-of-the-day commit may not touch. */
export function disallowedPaths(paths) {
  return paths.filter(p => !DAY_PATH.test(p));
}

/** The day directories (YYYY-MM-DD names) dated more than `keepDays` before `date`. */
export function daysToPrune(names, date, keepDays = 14) {
  const [y, m, d] = parseDate(date);
  const cutoff = new Date(Date.UTC(y, m - 1, d - keepDays)).toISOString().slice(0, 10);
  return names.filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n) && n < cutoff).sort();
}
