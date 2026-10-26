/**
 * Регресійні випадки розбору тексту: дні тижня без
 * апострофа, час через крапку, "ночі", кілька занять в одному рядку, спільна
 * кількість годин для кількох днів.
 */

import { describe, expect, it } from 'vitest';
import { parseDeadline, parseLessons, parseWeeklyHours } from '../../src/parse';
import { localParts } from '../../src/time';

const TZ = 'Europe/Kyiv';
// Середа, 11 листопада 2026, 10:00 за Києвом (UTC+2).
const NOW = Date.UTC(2026, 10, 11, 8, 0) / 1000;

function local(sec: number): string {
  const p = localParts(sec, TZ);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

describe('parseDeadline regressions', () => {
  it('understands Friday written without an apostrophe', () => {
    const r = parseDeadline('контрольна в пятницю о 10', NOW, TZ)!;
    expect(local(r.due)).toBe('2026-11-13 10:00');
    expect(r.title).toBe('Контрольна');
    expect(local(parseDeadline('реферат до пятниці', NOW, TZ)!.due)).toBe('2026-11-13 23:59');
  });

  it('turns 8-11 "ночі" into late evening', () => {
    expect(local(parseDeadline('здати о 11 ночі', NOW, TZ)!.due)).toBe('2026-11-11 23:00');
    expect(local(parseDeadline('завтра о 10 ночі реферат', NOW, TZ)!.due)).toBe('2026-11-12 22:00');
    expect(local(parseDeadline('завтра о 2 ночі', NOW, TZ)!.due)).toBe('2026-11-12 02:00');
  });

  it('reads dotted times after "о" and after a date', () => {
    const a = parseDeadline('реферат завтра о 15.30', NOW, TZ)!;
    expect(local(a.due)).toBe('2026-11-12 15:30');
    expect(a.title).toBe('Реферат');
    expect(local(parseDeadline('зустріч о 9.05 завтра', NOW, TZ)!.due)).toBe('2026-11-12 09:05');
    const c = parseDeadline('реферат 15.11 18.00', NOW, TZ)!;
    expect(local(c.due)).toBe('2026-11-15 18:00');
    expect(c.title).toBe('Реферат');
    expect(local(parseDeadline('есе до 20.11', NOW, TZ)!.due)).toBe('2026-11-20 23:59');
  });

  it('does not take a plain duration for a clock time', () => {
    expect(parseDeadline('прочитати 2 години', NOW, TZ)).toBeNull();
  });

  it('caps very long titles', () => {
    const r = parseDeadline(`${'дуже '.repeat(60)}довге завдання завтра`, NOW, TZ)!;
    expect(r.title.length).toBeLessThanOrEqual(100);
  });
});

describe('parseLessons regressions', () => {
  it('splits several comma-separated lessons on one line', () => {
    const { lessons, bad } = parseLessons('пн 8:30 Математика, вт 9:00 Фізика');
    expect(bad).toEqual([]);
    expect(lessons.map((l) => [l.weekdays, l.start, l.title])).toEqual([
      [[1], 510, 'Математика'],
      [[2], 540, 'Фізика'],
    ]);
  });

  it('keeps a day list before one time together', () => {
    const { lessons } = parseLessons('вт, чт 15:00 Англійська');
    expect(lessons).toHaveLength(1);
    expect(lessons[0].weekdays).toEqual([2, 4]);
  });
});

describe('parseWeeklyHours regressions', () => {
  it('applies one number to every day listed before it', () => {
    expect(parseWeeklyHours('пн, вт 2', [0, 0, 0, 0, 0, 0, 0])).toEqual([120, 120, 0, 0, 0, 0, 0]);
    expect(parseWeeklyHours('пн і ср 1.5, сб 3', [0, 0, 0, 0, 0, 0, 0])).toEqual([90, 0, 90, 0, 0, 180, 0]);
  });
});
