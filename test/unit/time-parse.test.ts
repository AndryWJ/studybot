/**
 * Модульні тести src/time.ts (пояси, DST, календарна арифметика, підписи) і
 * src/parse.ts (розбір дедлайнів, занять, тривалості й вільного часу українською).
 *
 * Усі моменти фіксовані. Базова "поточна мить" для дедлайнів: середа
 * 2026-11-11 10:00 за Києвом (зима, UTC+2).
 */

import { describe, expect, it } from 'vitest';
import {
  addDays,
  compareYmd,
  dayMonth,
  daysBetween,
  formatDate,
  formatDuration,
  formatMinutes,
  formatMoment,
  isValidTimeZone,
  isValidYmd,
  localParts,
  pad2,
  parseClock,
  parseYmd,
  plural,
  relativeLabel,
  weekdayOf,
  ymdToString,
  zonedToEpoch,
} from '../../src/time';
import { cleanTitle, parseDeadline, parseDuration, parseLessons, parseWeeklyHours } from '../../src/parse';

const TZ = 'Europe/Kyiv';

/** Unix-секунди для моменту в UTC. */
function utc(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute) / 1000;
}

/** Зима в Києві: UTC+2. */
function winter(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return utc(year, month, day, hour - 2, minute);
}

/** Літо в Києві: UTC+3. */
function summer(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return utc(year, month, day, hour - 3, minute);
}

/** Локальний вигляд моменту у Києві: "2026-11-25 18:00". */
function local(epochSec: number, tz = TZ): string {
  const p = localParts(epochSec, tz);
  return `${ymdToString(p)} ${formatMinutes(p.hour * 60 + p.minute)}`;
}

const NOW = winter(2026, 11, 11, 10, 0);

function parse(text: string, now = NOW) {
  return parseDeadline(text, now, TZ);
}

describe('localParts', () => {
  it('splits an instant into Kyiv summer wall time', () => {
    expect(localParts(utc(2026, 7, 1, 9, 0), TZ)).toEqual({ year: 2026, month: 7, day: 1, hour: 12, minute: 0, weekday: 3 });
  });

  it('splits an instant into Kyiv winter wall time', () => {
    expect(localParts(utc(2026, 11, 11, 8, 0), TZ)).toEqual({ year: 2026, month: 11, day: 11, hour: 10, minute: 0, weekday: 3 });
  });

  it('reports local midnight as hour 0, never 24', () => {
    const p = localParts(utc(2026, 11, 10, 22, 0), TZ);
    expect(p).toMatchObject({ month: 11, day: 11, hour: 0, minute: 0 });
  });

  it('rolls the date forward across UTC midnight for zones ahead of UTC', () => {
    const p = localParts(utc(2026, 12, 31, 23, 30), TZ);
    expect(p).toMatchObject({ year: 2027, month: 1, day: 1, hour: 1, minute: 30, weekday: 5 });
  });

  it('numbers Sunday as 7 and Monday as 1', () => {
    expect(localParts(winter(2026, 11, 15, 12), TZ).weekday).toBe(7);
    expect(localParts(winter(2026, 11, 16, 12), TZ).weekday).toBe(1);
  });

  it('shows the same wall time for both occurrences of the repeated autumn hour', () => {
    const first = localParts(utc(2026, 10, 25, 0, 30), TZ);
    const second = localParts(utc(2026, 10, 25, 1, 30), TZ);
    expect(first).toMatchObject({ day: 25, hour: 3, minute: 30 });
    expect(second).toMatchObject({ day: 25, hour: 3, minute: 30 });
  });

  it('works for zones behind UTC and for half-hour offsets', () => {
    expect(localParts(utc(2026, 1, 15, 17, 0), 'America/New_York')).toMatchObject({ hour: 12, day: 15 });
    expect(localParts(utc(2026, 1, 15, 6, 30), 'Asia/Kolkata')).toMatchObject({ hour: 12, minute: 0 });
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA names and rejects garbage', () => {
    expect(isValidTimeZone('Europe/Kyiv')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('zonedToEpoch', () => {
  it('converts ordinary winter and summer wall times', () => {
    expect(zonedToEpoch(2026, 11, 11, 10, 0, TZ)).toBe(utc(2026, 11, 11, 8, 0));
    expect(zonedToEpoch(2026, 7, 1, 12, 0, TZ)).toBe(utc(2026, 7, 1, 9, 0));
  });

  it('converts for zones behind UTC and with half-hour offsets', () => {
    expect(zonedToEpoch(2026, 1, 15, 12, 0, 'America/New_York')).toBe(utc(2026, 1, 15, 17, 0));
    expect(zonedToEpoch(2026, 1, 15, 12, 0, 'Asia/Kolkata')).toBe(utc(2026, 1, 15, 6, 30));
    expect(zonedToEpoch(2026, 1, 15, 12, 0, 'UTC')).toBe(utc(2026, 1, 15, 12, 0));
  });

  it('picks the earlier instant for the ambiguous 03:30 on the autumn fallback night', () => {
    const t = zonedToEpoch(2026, 10, 25, 3, 30, TZ);
    expect(t).toBe(utc(2026, 10, 25, 0, 30));
  });

  it('resolves wall times just outside the ambiguous autumn window', () => {
    expect(zonedToEpoch(2026, 10, 25, 2, 59, TZ)).toBe(utc(2026, 10, 24, 23, 59));
    expect(zonedToEpoch(2026, 10, 25, 4, 0, TZ)).toBe(utc(2026, 10, 25, 2, 0));
    expect(zonedToEpoch(2026, 10, 25, 4, 30, TZ)).toBe(utc(2026, 10, 25, 2, 30));
  });

  it('shifts the nonexistent 03:30 of the spring jump forward to 04:30', () => {
    const t = zonedToEpoch(2027, 3, 28, 3, 30, TZ);
    expect(t).toBe(utc(2027, 3, 28, 1, 30));
    expect(local(t)).toBe('2027-03-28 04:30');
  });

  it('shifts 03:00 of the spring jump to 04:00 and keeps neighbours exact', () => {
    expect(local(zonedToEpoch(2027, 3, 28, 3, 0, TZ))).toBe('2027-03-28 04:00');
    expect(zonedToEpoch(2027, 3, 28, 2, 59, TZ)).toBe(utc(2027, 3, 28, 0, 59));
    expect(zonedToEpoch(2027, 3, 28, 4, 0, TZ)).toBe(utc(2027, 3, 28, 1, 0));
  });

  it('round-trips every half hour around the autumn fallback except the repeated second pass', () => {
    const start = utc(2026, 10, 24, 20, 0);
    const end = utc(2026, 10, 25, 6, 0);
    const repeatedFrom = utc(2026, 10, 25, 1, 0);
    const repeatedTo = utc(2026, 10, 25, 2, 0);
    for (let t = start; t <= end; t += 1800) {
      const p = localParts(t, TZ);
      const back = zonedToEpoch(p.year, p.month, p.day, p.hour, p.minute, TZ);
      if (t >= repeatedFrom && t < repeatedTo) expect(back, local(t)).toBe(t - 3600);
      else expect(back, local(t)).toBe(t);
    }
  });

  it('round-trips every half hour around the spring jump', () => {
    const start = utc(2027, 3, 27, 20, 0);
    const end = utc(2027, 3, 28, 6, 0);
    for (let t = start; t <= end; t += 1800) {
      const p = localParts(t, TZ);
      expect(zonedToEpoch(p.year, p.month, p.day, p.hour, p.minute, TZ), local(t)).toBe(t);
    }
  });

  it('round-trips a sweep of daily noon instants over a full year', () => {
    for (let t = utc(2026, 1, 1, 10, 15); t < utc(2027, 1, 1); t += 86400) {
      const p = localParts(t, TZ);
      expect(zonedToEpoch(p.year, p.month, p.day, p.hour, p.minute, TZ)).toBe(t);
    }
  });

  it('puts the end of day 23:59 on the right side of the autumn transition day', () => {
    expect(local(zonedToEpoch(2026, 10, 25, 23, 59, TZ))).toBe('2026-10-25 23:59');
    expect(local(zonedToEpoch(2027, 3, 28, 23, 59, TZ))).toBe('2027-03-28 23:59');
  });
});

describe('calendar helpers', () => {
  it('addDays crosses month, year and leap-day boundaries', () => {
    expect(addDays({ year: 2026, month: 10, day: 31 }, 1)).toEqual({ year: 2026, month: 11, day: 1 });
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(addDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({ year: 2028, month: 2, day: 29 });
    expect(addDays({ year: 2027, month: 2, day: 28 }, 1)).toEqual({ year: 2027, month: 3, day: 1 });
    expect(addDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({ year: 2026, month: 2, day: 28 });
    expect(addDays({ year: 2026, month: 1, day: 1 }, 0)).toEqual({ year: 2026, month: 1, day: 1 });
    expect(addDays({ year: 2026, month: 1, day: 1 }, 365)).toEqual({ year: 2027, month: 1, day: 1 });
  });

  it('daysBetween is signed and calendar based', () => {
    const a = { year: 2026, month: 10, day: 24 };
    const b = { year: 2026, month: 10, day: 26 };
    expect(daysBetween(a, b)).toBe(2);
    expect(daysBetween(b, a)).toBe(-2);
    expect(daysBetween(a, a)).toBe(0);
    expect(daysBetween({ year: 2026, month: 12, day: 31 }, { year: 2027, month: 1, day: 1 })).toBe(1);
    expect(daysBetween({ year: 2027, month: 3, day: 27 }, { year: 2027, month: 3, day: 29 })).toBe(2);
  });

  it('weekdayOf numbers Monday 1 to Sunday 7', () => {
    expect(weekdayOf({ year: 2026, month: 10, day: 25 })).toBe(7);
    expect(weekdayOf({ year: 2026, month: 10, day: 26 })).toBe(1);
    expect(weekdayOf({ year: 2026, month: 11, day: 11 })).toBe(3);
    expect(weekdayOf({ year: 2026, month: 11, day: 14 })).toBe(6);
  });

  it('isValidYmd checks ranges, month lengths and leap years', () => {
    expect(isValidYmd({ year: 2028, month: 2, day: 29 })).toBe(true);
    expect(isValidYmd({ year: 2027, month: 2, day: 29 })).toBe(false);
    expect(isValidYmd({ year: 2026, month: 4, day: 31 })).toBe(false);
    expect(isValidYmd({ year: 2026, month: 13, day: 1 })).toBe(false);
    expect(isValidYmd({ year: 2026, month: 0, day: 1 })).toBe(false);
    expect(isValidYmd({ year: 2026, month: 1, day: 0 })).toBe(false);
    expect(isValidYmd({ year: 1999, month: 12, day: 31 })).toBe(false);
    expect(isValidYmd({ year: 2101, month: 1, day: 1 })).toBe(false);
    expect(isValidYmd({ year: 2000, month: 1, day: 1 })).toBe(true);
    expect(isValidYmd({ year: 2100, month: 12, day: 31 })).toBe(true);
  });

  it('parseYmd accepts strict YYYY-MM-DD only', () => {
    expect(parseYmd('2026-10-25')).toEqual({ year: 2026, month: 10, day: 25 });
    expect(parseYmd('  2026-10-25 ')).toEqual({ year: 2026, month: 10, day: 25 });
    expect(parseYmd('2026-02-30')).toBeNull();
    expect(parseYmd('2026-2-3')).toBeNull();
    expect(parseYmd('25.10.2026')).toBeNull();
    expect(parseYmd('1999-01-01')).toBeNull();
    expect(parseYmd('2026-10-25T10:00')).toBeNull();
    expect(parseYmd('')).toBeNull();
  });

  it('ymdToString and parseYmd are inverse', () => {
    const d = { year: 2027, month: 3, day: 5 };
    expect(ymdToString(d)).toBe('2027-03-05');
    expect(parseYmd(ymdToString(d))).toEqual(d);
  });

  it('compareYmd orders by year, month, day', () => {
    const a = { year: 2026, month: 11, day: 1 };
    expect(compareYmd(a, { year: 2027, month: 1, day: 1 })).toBeLessThan(0);
    expect(compareYmd(a, { year: 2026, month: 10, day: 31 })).toBeGreaterThan(0);
    expect(compareYmd(a, { ...a })).toBe(0);
  });

  it('pad2 pads single digits only', () => {
    expect(pad2(0)).toBe('00');
    expect(pad2(7)).toBe('07');
    expect(pad2(10)).toBe('10');
  });

  it('formatMinutes and parseClock handle minutes since midnight', () => {
    expect(formatMinutes(0)).toBe('00:00');
    expect(formatMinutes(510)).toBe('08:30');
    expect(formatMinutes(1439)).toBe('23:59');
    expect(parseClock('8:30')).toBe(510);
    expect(parseClock('08.30')).toBe(510);
    expect(parseClock(' 23:59 ')).toBe(1439);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('12:60')).toBeNull();
    expect(parseClock('830')).toBeNull();
    expect(parseClock('8:3')).toBeNull();
  });
});

describe('plural', () => {
  const days: [string, string, string] = ['день', 'дні', 'днів'];
  const cases: Array<[number, string]> = [
    [0, 'днів'],
    [1, 'день'],
    [2, 'дні'],
    [3, 'дні'],
    [4, 'дні'],
    [5, 'днів'],
    [9, 'днів'],
    [10, 'днів'],
    [11, 'днів'],
    [12, 'днів'],
    [14, 'днів'],
    [15, 'днів'],
    [21, 'день'],
    [22, 'дні'],
    [25, 'днів'],
    [100, 'днів'],
    [101, 'день'],
    [111, 'днів'],
    [112, 'днів'],
    [121, 'день'],
    [-1, 'день'],
    [-2, 'дні'],
    [-11, 'днів'],
  ];
  it.each(cases)('plural(%i) is "%s"', (n, expected) => {
    expect(plural(n, days)).toBe(expected);
  });

  it('returns the matching form of the supplied triple', () => {
    expect(`1 ${plural(1, days)}`).toBe('1 день');
    expect(`2 ${plural(2, days)}`).toBe('2 дні');
    expect(`5 ${plural(5, days)}`).toBe('5 днів');
    expect(`11 ${plural(11, days)}`).toBe('11 днів');
    expect(`21 ${plural(21, days)}`).toBe('21 день');
    expect(`22 ${plural(22, days)}`).toBe('22 дні');
    expect(`111 ${plural(111, days)}`).toBe('111 днів');
  });
});

describe('date labels', () => {
  const today = { year: 2026, month: 11, day: 11 };

  it('dayMonth names the month in genitive', () => {
    expect(dayMonth({ year: 2026, month: 11, day: 13 })).toBe('13 листопада');
    expect(dayMonth({ year: 2026, month: 3, day: 1 })).toBe('1 березня');
    expect(dayMonth({ year: 2026, month: 12, day: 31 })).toBe('31 грудня');
  });

  it('formatDate adds the year only when it differs from today', () => {
    expect(formatDate({ year: 2026, month: 11, day: 13 }, today)).toBe('пт, 13 листопада');
    expect(formatDate({ year: 2027, month: 1, day: 15 }, today)).toBe('пт, 15 січня 2027');
    expect(formatDate({ year: 2026, month: 11, day: 13 })).toBe('пт, 13 листопада');
  });

  it('formatMoment prints a timed deadline', () => {
    expect(formatMoment(winter(2026, 11, 13, 18, 0), TZ, false, NOW)).toBe('пт, 13 листопада о 18:00');
    expect(formatMoment(winter(2026, 11, 13, 9, 5), TZ, false, NOW)).toBe('пт, 13 листопада о 09:05');
  });

  it('formatMoment prints an all-day deadline', () => {
    expect(formatMoment(winter(2026, 11, 13, 23, 59), TZ, true, NOW)).toBe('пт, 13 листопада, до кінця дня');
  });

  it('formatMoment adds the year for another year and uses the local date near midnight', () => {
    expect(formatMoment(winter(2027, 1, 15, 9, 5), TZ, false, NOW)).toBe('пт, 15 січня 2027 о 09:05');
    expect(formatMoment(utc(2026, 11, 12, 22, 30), TZ, false, NOW)).toBe('пт, 13 листопада о 00:30');
  });
});

describe('relativeLabel', () => {
  const rel = (delta: number, allDay = false) => relativeLabel(NOW + delta, TZ, NOW, allDay);

  it('counts minutes below an hour and never says 0', () => {
    expect(rel(30 * 60)).toBe('через 30 хв');
    expect(rel(59 * 60)).toBe('через 59 хв');
    expect(rel(10)).toBe('через 1 хв');
    expect(rel(0)).toBe('через 1 хв');
  });

  it('counts hours with correct plural forms', () => {
    expect(rel(3600)).toBe('через 1 годину');
    expect(rel(2 * 3600)).toBe('через 2 години');
    expect(rel(5 * 3600)).toBe('через 5 годин');
    expect(rel(13 * 3600)).toBe('через 13 годин');
  });

  it('keeps hours for a soon deadline even when it falls after midnight', () => {
    const now = winter(2026, 11, 11, 22, 0);
    expect(relativeLabel(now + 5 * 3600, TZ, now)).toBe('через 5 годин');
  });

  it('switches to calendar days after six hours on another date', () => {
    expect(rel(20 * 3600)).toBe('завтра');
    expect(rel(24 * 3600)).toBe('завтра');
    expect(rel(48 * 3600)).toBe('післязавтра');
    expect(rel(3 * 86400)).toBe('через 3 дні');
    expect(rel(5 * 86400)).toBe('через 5 днів');
    expect(rel(11 * 86400)).toBe('через 11 днів');
    expect(rel(21 * 86400)).toBe('через 21 день');
    expect(rel(22 * 86400)).toBe('через 22 дні');
  });

  it('says today for an all-day deadline on the current date', () => {
    expect(relativeLabel(winter(2026, 11, 11, 23, 59), TZ, NOW, true)).toBe('сьогодні');
    expect(relativeLabel(winter(2026, 11, 12, 23, 59), TZ, NOW, true)).toBe('завтра');
  });

  it('counts calendar days across the autumn fallback even if 25 hours pass', () => {
    const now = summer(2026, 10, 24, 12, 0);
    const due = winter(2026, 10, 25, 12, 0);
    expect(due - now).toBe(25 * 3600);
    expect(relativeLabel(due, TZ, now)).toBe('завтра');
  });

  it('reports overdue deadlines by hours when within the same day', () => {
    expect(rel(-30)).toBe('щойно минув');
    expect(rel(-3599)).toBe('щойно минув');
    expect(rel(-3600)).toBe('прострочено на 1 годину');
    expect(rel(-2 * 3600)).toBe('прострочено на 2 години');
    expect(rel(-5 * 3600)).toBe('прострочено на 5 годин');
  });

  it('reports overdue deadlines by calendar days across midnight', () => {
    expect(relativeLabel(winter(2026, 11, 10, 23, 0), TZ, NOW)).toBe('прострочено на 1 день');
    expect(relativeLabel(winter(2026, 11, 8, 12, 0), TZ, NOW)).toBe('прострочено на 3 дні');
    expect(relativeLabel(winter(2026, 11, 6, 12, 0), TZ, NOW)).toBe('прострочено на 5 днів');
    expect(relativeLabel(winter(2026, 10, 21, 12, 0), TZ, NOW)).toBe('прострочено на 21 день');
  });
});

describe('formatDuration', () => {
  it('prints minutes only, hours only and both', () => {
    expect(formatDuration(0)).toBe('0 хв');
    expect(formatDuration(45)).toBe('45 хв');
    expect(formatDuration(60)).toBe('1 год');
    expect(formatDuration(120)).toBe('2 год');
    expect(formatDuration(90)).toBe('1 год 30 хв');
    expect(formatDuration(125)).toBe('2 год 5 хв');
  });

  it('clamps negatives and rounds fractions', () => {
    expect(formatDuration(-5)).toBe('0 хв');
    expect(formatDuration(0.4)).toBe('0 хв');
    expect(formatDuration(59.6)).toBe('1 год');
    expect(formatDuration(89.5)).toBe('1 год 30 хв');
  });
});

describe('cleanTitle', () => {
  it('strips filler words at the edges and capitalizes', () => {
    expect(cleanTitle('нагадай про контрольну')).toBe('Контрольну');
    expect(cleanTitle('  здати   звіт  до ')).toBe('Здати звіт');
    expect(cleanTitle('будь ласка нагадай подзвонити')).toBe('Подзвонити');
    expect(cleanTitle('дедлайн - проєкт')).toBe('Проєкт');
    expect(cleanTitle('- реферат ,')).toBe('Реферат');
  });

  it('strips a leading filler word that is followed by punctuation', () => {
    expect(cleanTitle('будь ласка, нагадай подзвонити')).toBe('Подзвонити');
    expect(cleanTitle('Дедлайн: проєкт')).toBe('Проєкт');
    expect(cleanTitle('нагадай, що треба купити зошит')).toBe('Купити зошит');
  });

  it('keeps inner prepositions and returns empty for filler only', () => {
    expect(cleanTitle('контрольна з фізики')).toBe('Контрольна з фізики');
    expect(cleanTitle('нагадай про')).toBe('');
    expect(cleanTitle('')).toBe('');
  });
});

describe('parseDeadline: absolute dates', () => {
  it('parses "25.11 18:00 Курсова з історії"', () => {
    const r = parse('25.11 18:00 Курсова з історії')!;
    expect(local(r.due)).toBe('2026-11-25 18:00');
    expect(r.allDay).toBe(false);
    expect(r.title).toBe('Курсова з історії');
  });

  it('parses "здати курсову до 15 грудня" as an all-day deadline', () => {
    const r = parse('здати курсову до 15 грудня')!;
    expect(local(r.due)).toBe('2026-12-15 23:59');
    expect(r.allDay).toBe(true);
    expect(r.title).toBe('Здати курсову');
  });

  it('accepts slash separators, two-digit and four-digit years', () => {
    expect(local(parse('25/11 18:00 звіт')!.due)).toBe('2026-11-25 18:00');
    expect(local(parse('20.11.2027 звіт')!.due)).toBe('2027-11-20 23:59');
    expect(local(parse('20.11.27 звіт')!.due)).toBe('2027-11-20 23:59');
    expect(local(parse('15 грудня 2027 року звіт')!.due)).toBe('2027-12-15 23:59');
  });

  it('rolls a past date without a year to the next year', () => {
    const r = parse('есе 01.09')!;
    expect(local(r.due)).toBe('2027-09-01 23:59');
    expect(r.allDay).toBe(true);
    expect(r.title).toBe('Есе');
    expect(local(parse('10.11 звіт')!.due)).toBe('2027-11-10 23:59');
    expect(local(parse('здати 1 вересня')!.due)).toBe('2027-09-01 23:59');
  });

  it('keeps today and later dates in the current year', () => {
    expect(local(parse('11.11 звіт')!.due)).toBe('2026-11-11 23:59');
    expect(local(parse('12.11 звіт')!.due)).toBe('2026-11-12 23:59');
    expect(local(parse('31 грудня звіт')!.due)).toBe('2026-12-31 23:59');
  });

  it('keeps an explicit past year as is', () => {
    expect(local(parse('01.09.2025 звіт')!.due)).toBe('2025-09-01 23:59');
  });

  it('recognises month names in several declensions and abbreviations', () => {
    expect(local(parse('до 3 січня звіт')!.due)).toBe('2027-01-03 23:59');
    expect(local(parse('до 20 листоп. звіт')!.due)).toBe('2026-11-20 23:59');
    expect(local(parse('до 20 груд. звіт')!.due)).toBe('2026-12-20 23:59');
    expect(local(parse('до 5 квітня звіт')!.due)).toBe('2027-04-05 23:59');
  });

  it('reads 12.30 as a time, not a date (month 30 does not exist)', () => {
    const r = parse('зустріч 12.30')!;
    expect(r.allDay).toBe(false);
    expect(local(r.due).slice(11)).toBe('12:30');
    expect(r.title).toBe('Зустріч');
  });

  it('skips an invalid candidate date and accepts a later valid one', () => {
    const r = parse('глава 31.02 здати 20.11')!;
    expect(local(r.due)).toBe('2026-11-20 23:59');
  });

  it('rejects impossible calendar dates', () => {
    expect(parse('31.02 звіт')).toBeNull();
    expect(parse('32 грудня звіт')).toBeNull();
    expect(parse('30.02.2027 звіт')).toBeNull();
  });

  it('resolves 29.02 typed in a non-leap year to the coming leap day', () => {
    const now = winter(2027, 11, 11, 10, 0);
    expect(local(parse('29.02 звіт', now)!.due)).toBe('2028-02-29 23:59');
    expect(local(parse('29 лютого звіт', now)!.due)).toBe('2028-02-29 23:59');
  });

  it('never rolls a past 29 February onto a nonexistent date', () => {
    const now = winter(2028, 3, 10, 10, 0);
    const r = parse('29.02 звіт', now);
    expect(r === null || local(r.due).slice(5, 10) === '02-29').toBe(true);
  });

  it('accepts 29.02 in a leap year', () => {
    const now = winter(2028, 1, 10, 10, 0);
    expect(local(parse('29.02 звіт', now)!.due)).toBe('2028-02-29 23:59');
  });
});

describe('parseDeadline: times', () => {
  it('parses "контрольна з фізики в четвер о 10"', () => {
    const r = parse('контрольна з фізики в четвер о 10')!;
    expect(local(r.due)).toBe('2026-11-12 10:00');
    expect(r.allDay).toBe(false);
    expect(r.title).toBe('Контрольна з фізики');
  });

  it('parses "нагадай завтра о 9 вечора подзвонити"', () => {
    const r = parse('нагадай завтра о 9 вечора подзвонити')!;
    expect(local(r.due)).toBe('2026-11-12 21:00');
    expect(r.allDay).toBe(false);
    expect(r.title).toBe('Подзвонити');
  });

  it('parses "через 2 години купити зошит"', () => {
    const r = parse('через 2 години купити зошит')!;
    expect(r.due).toBe(NOW + 7200);
    expect(r.allDay).toBe(false);
    expect(r.title).toBe('Купити зошит');
  });

  it('parses relative minutes, a bare hour and half an hour', () => {
    expect(parse('через 40 хв чай')!.due).toBe(NOW + 40 * 60);
    expect(parse('через 15 хвилин чай')!.due).toBe(NOW + 15 * 60);
    expect(parse('через годину чай')!.due).toBe(NOW + 3600);
    expect(parse('через хвилину чай')!.due).toBe(NOW + 60);
    expect(parse('через півгодини чай')!.due).toBe(NOW + 1800);
    expect(parse('через 3 години чай')!.due).toBe(NOW + 3 * 3600);
  });

  it('parses fractional hours after "через"', () => {
    const r = parse('через 1.5 години чай')!;
    expect(r.due).toBe(NOW + 5400);
    expect(r.allDay).toBe(false);
    expect(r.title).toBe('Чай');
    expect(parse('через 2,5 години чай')!.due).toBe(NOW + 9000);
  });

  it('parses hours plus minutes after "через"', () => {
    const r = parse('через 2 години 30 хв чай')!;
    expect(r.due).toBe(NOW + 150 * 60);
    expect(r.title).toBe('Чай');
  });

  it('rounds a relative moment to a whole minute', () => {
    const now = NOW + 20;
    const r = parse('через 2 хв чай', now)!;
    expect(r.due % 60).toBe(0);
    expect(r.due).toBe(NOW + 120);
  });

  it('takes a clock time with a date', () => {
    expect(local(parse('завтра 14:30 зустріч')!.due)).toBe('2026-11-12 14:30');
    expect(local(parse('зустріч в 15:30 завтра')!.due)).toBe('2026-11-12 15:30');
    expect(local(parse('зустріч о 9:05 завтра')!.due)).toBe('2026-11-12 09:05');
  });

  it('time without a date means today when still ahead, otherwise tomorrow', () => {
    expect(local(parse('зустріч о 15')!.due)).toBe('2026-11-11 15:00');
    expect(local(parse('зарядка о 8 ранку')!.due)).toBe('2026-11-12 08:00');
    expect(local(parse('зустріч о 10')!.due)).toBe('2026-11-12 10:00');
    expect(local(parse('зустріч 10:01')!.due)).toBe('2026-11-11 10:01');
  });

  it('applies day-part words', () => {
    expect(local(parse('завтра о 9 вечора звіт')!.due)).toBe('2026-11-12 21:00');
    expect(local(parse('завтра о 9 ранку звіт')!.due)).toBe('2026-11-12 09:00');
    expect(local(parse('завтра о 2 дня звіт')!.due)).toBe('2026-11-12 14:00');
    expect(local(parse('завтра о 12 дня звіт')!.due)).toBe('2026-11-12 12:00');
    expect(local(parse('завтра о 2 ночі звіт')!.due)).toBe('2026-11-12 02:00');
    expect(local(parse('завтра о 12 ночі звіт')!.due)).toBe('2026-11-12 00:00');
    expect(local(parse('завтра о 12 вечора звіт')!.due)).toBe('2026-11-12 12:00');
    expect(local(parse('завтра 7:30 вечора звіт')!.due)).toBe('2026-11-12 19:30');
  });

  it('parses "о 12 дня" without a date as noon today', () => {
    const r = parse('нагадай о 12 дня зателефонувати')!;
    expect(local(r.due)).toBe('2026-11-11 12:00');
    expect(r.title).toBe('Зателефонувати');
  });

  it('parses "о 2 ночі" without a date as tomorrow at 02:00', () => {
    expect(local(parse('о 2 ночі прокинутись')!.due)).toBe('2026-11-12 02:00');
  });

  it('parses "до опівночі" as 23:59 and "опівдні" as 12:00', () => {
    const r = parse('здати лабу до опівночі')!;
    expect(local(r.due)).toBe('2026-11-11 23:59');
    expect(r.allDay).toBe(false);
    expect(r.title).toBe('Здати лабу');
    expect(local(parse('завтра опівдні обід')!.due)).toBe('2026-11-12 12:00');
  });

  it('reads "о 24" as the end of the day and rejects hours above 24', () => {
    expect(local(parse('завтра о 24 звіт')!.due)).toBe('2026-11-12 23:59');
    expect(parse('зустріч о 25')).toBeNull();
  });

  it('understands "до 18 години" and "18 год" style hours', () => {
    expect(local(parse('завтра до 18 години звіт')!.due)).toBe('2026-11-12 18:00');
    expect(local(parse('завтра 18 год звіт')!.due)).toBe('2026-11-12 18:00');
    expect(local(parse('звіт завтра в 18')!.due)).toBe('2026-11-12 18:00');
  });

  it('reads a dotted time after "о" like the colon form', () => {
    const r = parse('зустріч завтра о 9.30')!;
    expect(local(r.due)).toBe('2026-11-12 09:30');
    expect(r.title).toBe('Зустріч');
  });

  it('does not take a bare duration in hours as a clock time', () => {
    expect(parse('прочитати 2 години')).toBeNull();
    expect(parse('вчити 3 години щодня')).toBeNull();
  });

  it('does not take a page count as a time', () => {
    const r = parse('реферат на 10 сторінок до п’ятниці')!;
    expect(local(r.due)).toBe('2026-11-13 23:59');
    expect(r.allDay).toBe(true);
    expect(r.title).toBe('Реферат на 10 сторінок');
  });

  it('does not take counts and class numbers as times', () => {
    expect(parse('реферат на 10 сторінок')).toBeNull();
    expect(parse('вчитель в 2 класі')).toBeNull();
    expect(parse('діти у 3 класі')).toBeNull();
    expect(parse('прочитати 10 сторінок')).toBeNull();
    const r = parse('прочитати 10 сторінок до 20.11')!;
    expect(local(r.due)).toBe('2026-11-20 23:59');
    expect(r.title).toBe('Прочитати 10 сторінок');
  });

  it('does not take a lone preposition plus number inside a sentence as a time', () => {
    expect(parse('купити в 2 рази більше')).toBeNull();
  });
});

describe('parseDeadline: relative days and words', () => {
  it('parses "через тиждень есе"', () => {
    const r = parse('через тиждень есе')!;
    expect(local(r.due)).toBe('2026-11-18 23:59');
    expect(r.allDay).toBe(true);
    expect(r.title).toBe('Есе');
  });

  it('parses day, week and month offsets', () => {
    expect(local(parse('через 3 дні звіт')!.due)).toBe('2026-11-14 23:59');
    expect(local(parse('через день звіт')!.due)).toBe('2026-11-12 23:59');
    expect(local(parse('через 2 тижні звіт')!.due)).toBe('2026-11-25 23:59');
    expect(local(parse('через два тижні звіт')!.due)).toBe('2026-11-25 23:59');
    expect(local(parse('через місяць звіт')!.due)).toBe('2026-12-11 23:59');
    expect(local(parse('через 2 місяці звіт')!.due)).toBe('2027-01-11 23:59');
  });

  it('clamps a month offset to the last day of a shorter month', () => {
    const now = winter(2027, 1, 31, 10, 0);
    expect(local(parse('через місяць звіт', now)!.due)).toBe('2027-02-28 23:59');
  });

  it('combines a relative day offset with a time', () => {
    expect(local(parse('через 3 дні о 15 звіт')!.due)).toBe('2026-11-14 15:00');
  });

  it('parses today, tomorrow and the day after tomorrow', () => {
    expect(local(parse('сьогодні звіт')!.due)).toBe('2026-11-11 23:59');
    expect(local(parse('завтра звіт')!.due)).toBe('2026-11-12 23:59');
    expect(local(parse('післязавтра звіт')!.due)).toBe('2026-11-13 23:59');
    expect(local(parse('сьогодні о 18 звіт')!.due)).toBe('2026-11-11 18:00');
  });

  it('a past time today stays in the past because the caller validates', () => {
    expect(local(parse('сьогодні о 8 звіт')!.due)).toBe('2026-11-11 08:00');
  });

  it('rolls tomorrow across month and year ends', () => {
    const now = winter(2026, 12, 31, 10, 0);
    expect(local(parse('завтра звіт', now)!.due)).toBe('2027-01-01 23:59');
  });
});

describe('parseDeadline: weekdays', () => {
  it('parses a bare weekday as the next occurrence, all day', () => {
    const r = parse('здати звіт у п’ятницю')!;
    expect(local(r.due)).toBe('2026-11-13 23:59');
    expect(r.allDay).toBe(true);
    expect(local(parse('здати звіт в понеділок')!.due)).toBe('2026-11-16 23:59');
    expect(local(parse('здати звіт в неділю')!.due)).toBe('2026-11-15 23:59');
    expect(local(parse('здати звіт в суботу')!.due)).toBe('2026-11-14 23:59');
  });

  it('parses abbreviations and English tokens', () => {
    expect(local(parse('звіт пт')!.due)).toBe('2026-11-13 23:59');
    expect(local(parse('звіт в пн о 9')!.due)).toBe('2026-11-16 09:00');
    expect(local(parse('звіт fri')!.due)).toBe('2026-11-13 23:59');
  });

  it('handles every apostrophe variant of "п’ятниця"', () => {
    for (const word of ["п'ятниця", 'п’ятниця', 'пʼятниця', 'п`ятниця', 'П’ЯТНИЦЯ', "п'ятницю", 'п’ятниці']) {
      const r = parse(`реферат до ${word}`);
      expect(r, word).not.toBeNull();
      expect(local(r!.due), word).toBe('2026-11-13 23:59');
      expect(r!.title, word).toBe('Реферат');
    }
  });

  it('on the same weekday without a time means next week', () => {
    expect(local(parse('здати в середу')!.due)).toBe('2026-11-18 23:59');
  });

  it('on the same weekday with a later time means today', () => {
    expect(local(parse('здати в середу о 15')!.due)).toBe('2026-11-11 15:00');
    expect(local(parse('здати в середу 10:01')!.due)).toBe('2026-11-11 10:01');
  });

  it('on the same weekday with an earlier or equal time means next week', () => {
    expect(local(parse('здати в середу о 9')!.due)).toBe('2026-11-18 09:00');
    expect(local(parse('здати в середу о 10')!.due)).toBe('2026-11-18 10:00');
  });

  it('"наступної п’ятниці" skips this week even when the day is still ahead', () => {
    const r = parse('наступної п’ятниці здати звіт')!;
    expect(local(r.due)).toBe('2026-11-20 23:59');
    expect(r.allDay).toBe(true);
    expect(r.title).toBe('Здати звіт');
    expect(local(parse('здати звіт в наступну п’ятницю')!.due)).toBe('2026-11-20 23:59');
  });

  it('"наступного понеділка" from Wednesday is the Monday after the coming one', () => {
    expect(local(parse('наступного понеділка звіт')!.due)).toBe('2026-11-16 23:59');
  });

  it('accepts "цю п’ятницю" like a plain weekday', () => {
    expect(local(parse('звіт цю п’ятницю')!.due)).toBe('2026-11-13 23:59');
  });

  it('a weekday combined with a clock time keeps the title clean', () => {
    const r = parse('семінар у вівторок 14:30 історія')!;
    expect(local(r.due)).toBe('2026-11-17 14:30');
    expect(r.title).toBe('Семінар історія');
  });

  it('does not take weekday abbreviations from inside other words', () => {
    expect(parse('купити пташку')).toBeNull();
    expect(parse('середній бал')).toBeNull();
  });
});

describe('parseDeadline: titles and non-matches', () => {
  it('strips "нагадай", "про" and trailing prepositions', () => {
    expect(parse('нагадай про контрольну завтра')!.title).toBe('Контрольну');
    expect(parse('нагадай мені про есе 20.11')!.title).toBe('Есе');
    expect(parse('реферат до 20.11')!.title).toBe('Реферат');
    expect(parse('реферат на 20.11')!.title).toBe('Реферат');
    expect(parse('здати звіт, 20.11')!.title).toBe('Здати звіт');
    expect(parse('дедлайн - проєкт 20.11')!.title).toBe('Проєкт');
  });

  it('strips a leading "Дедлайн:" label that is followed by a colon', () => {
    expect(parse('Дедлайн: проєкт 20.11')!.title).toBe('Проєкт');
  });

  it('keeps original capitalisation of the rest of the title', () => {
    expect(parse('20.11 здати звіт в Prozorro')!.title).toBe('Здати звіт в Prozorro');
  });

  it('falls back to "Дедлайн" when only the date and time are present', () => {
    expect(parse('завтра о 9')!.title).toBe('Дедлайн');
    expect(parse('25.11')!.title).toBe('Дедлайн');
    expect(parse('нагадай про 25.11')!.title).toBe('Дедлайн');
  });

  it('returns null without a date or time', () => {
    expect(parse('купити хліб')).toBeNull();
    expect(parse('')).toBeNull();
    expect(parse('   ')).toBeNull();
    expect(parse('привіт')).toBeNull();
    expect(parse('вивчити 15 слів')).toBeNull();
  });

  it('ignores text beyond the first 500 characters', () => {
    const r = parse(`${'а'.repeat(600)} завтра`);
    expect(r).toBeNull();
  });
});

describe('parseDeadline: DST', () => {
  it('maps an ambiguous autumn time to the earlier instant', () => {
    const now = summer(2026, 10, 24, 12, 0);
    const r = parse('25.10 03:30 пара', now)!;
    expect(r.due).toBe(utc(2026, 10, 25, 0, 30));
    expect(r.title).toBe('Пара');
  });

  it('shifts a nonexistent spring time forward', () => {
    const now = winter(2027, 3, 20, 12, 0);
    const r = parse('28.03 03:30 пара', now)!;
    expect(local(r.due)).toBe('2027-03-28 04:30');
  });

  it('computes tomorrow at 10:00 from before the autumn fallback with the new offset', () => {
    const now = summer(2026, 10, 24, 12, 0);
    const r = parse('завтра о 10 звіт', now)!;
    expect(r.due).toBe(winter(2026, 10, 25, 10, 0));
    expect(local(r.due)).toBe('2026-10-25 10:00');
  });

  it('relative hours are exact elapsed time across the fallback', () => {
    const now = utc(2026, 10, 25, 0, 30);
    expect(parse('через 2 години звіт', now)!.due).toBe(now + 7200);
    expect(local(now + 7200)).toBe('2026-10-25 04:30');
  });

  it('a weekday deadline stays on the right calendar date across the fallback', () => {
    const now = summer(2026, 10, 24, 12, 0);
    const r = parse('звіт в понеділок о 9', now)!;
    expect(local(r.due)).toBe('2026-10-26 09:00');
  });
});

describe('parseLessons', () => {
  const one = (line: string) => {
    const { lessons, bad } = parseLessons(line);
    expect(bad, line).toEqual([]);
    expect(lessons, line).toHaveLength(1);
    return lessons[0];
  };

  it('parses a single day with a time range', () => {
    expect(one('пн 08:30-09:15 Математика')).toEqual({ weekdays: [1], start: 510, end: 555, title: 'Математика' });
  });

  it('parses a day list separated by commas', () => {
    expect(one('вт, чт 15:00 Англійська')).toEqual({ weekdays: [2, 4], start: 900, end: null, title: 'Англійська' });
    expect(one('пн, ср, пт 9:00 Лекція')).toMatchObject({ weekdays: [1, 3, 5], start: 540 });
  });

  it('parses a day range with a dotted time', () => {
    expect(one('пн-пт 8.30 Зарядка')).toEqual({ weekdays: [1, 2, 3, 4, 5], start: 510, end: null, title: 'Зарядка' });
  });

  it('wraps a range that crosses Sunday', () => {
    expect(one('сб-пн 10:00 Курс')).toMatchObject({ weekdays: [1, 6, 7] });
  });

  it('parses "щодня"', () => {
    expect(one('щодня 21:00 Читання')).toEqual({ weekdays: [1, 2, 3, 4, 5, 6, 7], start: 1260, end: null, title: 'Читання' });
  });

  it('parses weekdays and weekends keywords', () => {
    expect(one('будні 7:00 Пробіжка')).toEqual({ weekdays: [1, 2, 3, 4, 5], start: 420, end: null, title: 'Пробіжка' });
    expect(one('вихідні 10:00 Басейн')).toEqual({ weekdays: [6, 7], start: 600, end: null, title: 'Басейн' });
    expect(one('по буднях 7:00 Пробіжка')).toMatchObject({ weekdays: [1, 2, 3, 4, 5] });
    expect(one('у вихідні 10:00 Басейн')).toMatchObject({ weekdays: [6, 7] });
  });

  it('parses "у середу з 16:00 до 17:00 Гурток"', () => {
    expect(one('у середу з 16:00 до 17:00 Гурток')).toEqual({ weekdays: [3], start: 960, end: 1020, title: 'Гурток' });
  });

  it('accepts full weekday names and an en dash in ranges', () => {
    expect(one('понеділок 8:00 Фізика')).toMatchObject({ weekdays: [1], start: 480, title: 'Фізика' });
    expect(one('пʼятниця 14:00 Хімія')).toMatchObject({ weekdays: [5], start: 840 });
    expect(one('пн–ср 8:00–9:00 Фізика')).toMatchObject({ weekdays: [1, 2, 3], start: 480, end: 540 });
  });

  it('drops an end time that is not after the start', () => {
    expect(one('пн 10:00-09:00 Фізика').end).toBeNull();
    expect(one('пн 10:00-10:00 Фізика').end).toBeNull();
  });

  it('puts the title before or after the time', () => {
    expect(one('Математика пн 8:30')).toMatchObject({ weekdays: [1], start: 510, title: 'Математика' });
  });

  it('splits lessons by newlines and semicolons and keeps order', () => {
    const { lessons, bad } = parseLessons('пн 8:30 Математика\nвт 9:00 Фізика; ср 10:00 Хімія\n\n   ');
    expect(bad).toEqual([]);
    expect(lessons.map((l) => l.title)).toEqual(['Математика', 'Фізика', 'Хімія']);
    expect(lessons.map((l) => l.weekdays)).toEqual([[1], [2], [3]]);
  });

  it('collects invalid lines in bad and still returns the valid ones', () => {
    const { lessons, bad } = parseLessons(
      ['пн 8:30 Математика', 'Математика без часу', 'пн Математика', 'пн 25:00 Фізика', 'пн 8:30', 'вт 9:61 Хімія', 'ср 10:00 Біологія'].join('\n'),
    );
    expect(lessons.map((l) => l.title)).toEqual(['Математика', 'Біологія']);
    expect(bad).toEqual(['Математика без часу', 'пн Математика', 'пн 25:00 Фізика', 'пн 8:30', 'вт 9:61 Хімія']);
  });

  it('returns empty results for empty input', () => {
    expect(parseLessons('')).toEqual({ lessons: [], bad: [] });
    expect(parseLessons('\n ; \n')).toEqual({ lessons: [], bad: [] });
  });

  it('truncates very long titles to 100 characters', () => {
    const l = one(`пн 8:30 ${'а'.repeat(150)}`);
    expect(l.title).toHaveLength(100);
  });

  it('does not leak conjunctions between days into the title', () => {
    expect(one('пн і ср 9:00 Школа')).toEqual({ weekdays: [1, 3], start: 540, end: null, title: 'Школа' });
    expect(one('пн, ср та пт 9:00 Англійська')).toMatchObject({ weekdays: [1, 3, 5], title: 'Англійська' });
  });

  it('does not take weekday abbreviations from inside the title', () => {
    expect(one('пн 8:30 Середньовічна історія')).toMatchObject({ weekdays: [1], title: 'Середньовічна історія' });
  });
});

describe('parseDuration', () => {
  it('parses minutes and returns the rest as the subject', () => {
    expect(parseDuration('45 хв математика')).toEqual({ minutes: 45, rest: 'Математика' });
    expect(parseDuration('математика 45 хв')).toEqual({ minutes: 45, rest: 'Математика' });
    expect(parseDuration('90 хвилин фізика')).toEqual({ minutes: 90, rest: 'Фізика' });
    expect(parseDuration('30 min physics')).toEqual({ minutes: 30, rest: 'Physics' });
  });

  it('parses decimal hours with a dot or a comma', () => {
    expect(parseDuration('1.5 год фізика')).toEqual({ minutes: 90, rest: 'Фізика' });
    expect(parseDuration('1,5 год')).toEqual({ minutes: 90, rest: '' });
    expect(parseDuration('2 години хімія')).toEqual({ minutes: 120, rest: 'Хімія' });
    expect(parseDuration('2h chem')).toEqual({ minutes: 120, rest: 'Chem' });
    expect(parseDuration('0.25 год біологія')).toEqual({ minutes: 15, rest: 'Біологія' });
  });

  it('adds hours and minutes', () => {
    expect(parseDuration('1 год 20 хв історія')).toEqual({ minutes: 80, rest: 'Історія' });
    expect(parseDuration('2 год 5 хв')).toEqual({ minutes: 125, rest: '' });
  });

  it('parses a clock-like duration', () => {
    expect(parseDuration('1:20 англійська')).toEqual({ minutes: 80, rest: 'Англійська' });
    expect(parseDuration('0:45 читання')).toEqual({ minutes: 45, rest: 'Читання' });
  });

  it('parses "півтори години", "пів години" and "годину"', () => {
    expect(parseDuration('півтори години хімія')).toEqual({ minutes: 90, rest: 'Хімія' });
    expect(parseDuration('пів години хімія')).toEqual({ minutes: 30, rest: 'Хімія' });
    expect(parseDuration('півгодини хімія')).toEqual({ minutes: 30, rest: 'Хімія' });
    expect(parseDuration('годину біологія')).toEqual({ minutes: 60, rest: 'Біологія' });
  });

  it('rejects zero, missing and over-long durations', () => {
    expect(parseDuration('0 хв математика')).toBeNull();
    expect(parseDuration('0 год')).toBeNull();
    expect(parseDuration('0:00 читання')).toBeNull();
    expect(parseDuration('математика')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('17 год фізика')).toBeNull();
    expect(parseDuration('16 год 1 хв фізика')).toBeNull();
    expect(parseDuration('1000 хв фізика')).toBeNull();
  });

  it('accepts exactly 16 hours', () => {
    expect(parseDuration('16 год сон')).toEqual({ minutes: 960, rest: 'Сон' });
  });

  it('does not take a number without a unit as a duration', () => {
    expect(parseDuration('45 математика')).toBeNull();
  });

  it('does not take a word that merely starts with a unit letter as minutes', () => {
    expect(parseDuration('5 метрів')).toBeNull();
  });
});

describe('parseWeeklyHours', () => {
  const base = [60, 60, 60, 60, 60, 120, 120];

  it('parses weekday and weekend groups (bare numbers are hours)', () => {
    expect(parseWeeklyHours('будні 2, вихідні 3', base)).toEqual([120, 120, 120, 120, 120, 180, 180]);
  });

  it('parses a range, single days, decimals and an explicit zero', () => {
    expect(parseWeeklyHours('пн-пт 1.5 год, сб 4, нд 0', base)).toEqual([90, 90, 90, 90, 90, 240, 0]);
  });

  it('parses minutes with the unit', () => {
    expect(parseWeeklyHours('щодня 90 хв', base)).toEqual([90, 90, 90, 90, 90, 90, 90]);
    expect(parseWeeklyHours('пн 45 хвилин', base)).toEqual([45, 60, 60, 60, 60, 120, 120]);
  });

  it('parses a comma decimal and an hour unit', () => {
    expect(parseWeeklyHours('вт 1,5 год', base)).toEqual([60, 90, 60, 60, 60, 120, 120]);
  });

  it('keeps base values for days that are not mentioned and does not mutate base', () => {
    const snapshot = [...base];
    expect(parseWeeklyHours('ср 3', base)).toEqual([60, 60, 180, 60, 60, 120, 120]);
    expect(base).toEqual(snapshot);
  });

  it('is case-insensitive and accepts separators between day and number', () => {
    expect(parseWeeklyHours('Будні: 2, Вихідні = 3', base)).toEqual([120, 120, 120, 120, 120, 180, 180]);
    expect(parseWeeklyHours('у вівторок 2', base)).toEqual([60, 120, 60, 60, 60, 120, 120]);
  });

  it('accepts full weekday names and "кожен день"', () => {
    expect(parseWeeklyHours('субота 5 год', base)).toEqual([60, 60, 60, 60, 60, 300, 120]);
    expect(parseWeeklyHours('кожен день 2', base)).toEqual([120, 120, 120, 120, 120, 120, 120]);
  });

  it('accepts "кожного дня" like parseLessons does', () => {
    expect(parseWeeklyHours('кожного дня 2', base)).toEqual([120, 120, 120, 120, 120, 120, 120]);
  });

  it('lets a later group override an earlier one', () => {
    expect(parseWeeklyHours('щодня 1, нд 0', base)).toEqual([60, 60, 60, 60, 60, 60, 0]);
  });

  it('returns null when nothing is recognised', () => {
    expect(parseWeeklyHours('багато часу', base)).toBeNull();
    expect(parseWeeklyHours('', base)).toBeNull();
    expect(parseWeeklyHours('2, 3', base)).toBeNull();
  });

  it('ignores values above 16 hours and keeps recognising the rest', () => {
    expect(parseWeeklyHours('будні 20, вихідні 3', base)).toEqual([60, 60, 60, 60, 60, 180, 180]);
    expect(parseWeeklyHours('будні 20', base)).toBeNull();
  });
});
