/**
 * Час і дати: перетворення між моментом в UTC і локальним часом користувача,
 * українські назви днів і місяців, людські підписи на кшталт "через 2 дні".
 *
 * Домовленість для всього проєкту: момент часу (дедлайн, нагадування) зберігається
 * як unix-секунди UTC, а календарна дата без часу (крок плану) як рядок YYYY-MM-DD
 * у часовому поясі користувача. Хвилини доби (розклад) рахуються від локальної
 * півночі: 8:30 це 510.
 */

/** Локальний час у конкретному поясі. `weekday`: 1 понеділок ... 7 неділя. */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

/** Скорочені назви днів тижня з понеділка; індекс це weekday - 1. */
export const WEEKDAYS_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд'];
/** Повні назви днів тижня з понеділка; індекс це weekday - 1. */
export const WEEKDAYS_FULL = ['понеділок', 'вівторок', 'середа', 'четвер', "п'ятниця", 'субота', 'неділя'];
const MONTHS_GENITIVE = [
  'січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
  'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня',
];
const WEEKDAY_BY_EN: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Чи знає середовище такий IANA-пояс (наприклад, "Europe/Kyiv"). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Розкладає момент `epochSec` на локальні дату й час у поясі `tz`. */
export function localParts(epochSec: number, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(new Date(epochSec * 1000));
  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    // Деякі рушії віддають "24" для півночі навіть із h23.
    hour: Number(value('hour')) % 24,
    minute: Number(value('minute')),
    weekday: WEEKDAY_BY_EN[value('weekday')] ?? 1,
  };
}

/** Зсув поясу від UTC у секундах у момент `epochSec` (Київ улітку: 10800). */
function offsetAt(epochSec: number, tz: string): number {
  const p = localParts(epochSec, tz);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 1000;
  return wallAsUtc - Math.floor(epochSec / 60) * 60;
}

/**
 * Перетворює локальний настінний час у поясі `tz` на unix-секунди UTC.
 *
 * Час, якого не існує через перехід на літній час (03:30 в ніч переходу),
 * зсувається вперед на величину переходу. Неоднозначний час осіннього переходу
 * (03:30, що буває двічі) дає ранніший із двох моментів. Припускає, що в межах
 * доби навколо дати буває не більше одного переходу, що правда для реальних поясів.
 */
export function zonedToEpoch(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  const before = offsetAt(naive - 86400, tz);
  const after = offsetAt(naive + 86400, tz);
  const t1 = naive - before;
  const t2 = naive - after;
  const ok1 = offsetAt(t1, tz) === before;
  const ok2 = offsetAt(t2, tz) === after;
  if (ok1 && ok2) return Math.min(t1, t2);
  if (ok2 && !ok1) return t2;
  return t1;
}

/** Календарна дата без часу. */
export interface Ymd {
  year: number;
  month: number;
  day: number;
}

/** Лишає з локальних частин часу лише календарну дату. */
export function ymdOf(p: Ymd): Ymd {
  return { year: p.year, month: p.month, day: p.day };
}

/** Додає `days` календарних днів (можна від'ємне число). */
export function addDays(d: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** День тижня дати: 1 понеділок ... 7 неділя. */
export function weekdayOf(d: Ymd): number {
  const js = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  return js === 0 ? 7 : js;
}

/** Кількість днів від `a` до `b` (b пізніше дає додатне число). */
export function daysBetween(a: Ymd, b: Ymd): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000);
}

/** Чи існує така дата: рік 2000-2100, з урахуванням довжини місяця й високосних років. */
export function isValidYmd(d: Ymd): boolean {
  if (d.month < 1 || d.month > 12 || d.day < 1 || d.year < 2000 || d.year > 2100) return false;
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return t.getUTCMonth() === d.month - 1 && t.getUTCDate() === d.day;
}

/** Дата у вигляді "YYYY-MM-DD". */
export function ymdToString(d: Ymd): string {
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`;
}

/** Розбирає "YYYY-MM-DD"; повертає null для інших форматів і неіснуючих дат. */
export function parseYmd(s: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  return isValidYmd(d) ? d : null;
}

/** Від'ємне число, якщо `a` раніше за `b`, нуль при рівності, додатне, якщо пізніше. */
export function compareYmd(a: Ymd, b: Ymd): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/** Число з нулем попереду до двох цифр (для 0-99). */
export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Хвилини від півночі у вигляді "08:30". */
export function formatMinutes(min: number): string {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

/** Розбирає "8:30" чи "08.30" у хвилини від півночі; null, якщо час некоректний. */
export function parseClock(s: string): number | null {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Обирає форму слова за числом за українськими правилами.
 * `forms`: [1 день, 2 дні, 5 днів].
 */
export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

/** "13 листопада". */
export function dayMonth(d: Ymd): string {
  return `${d.day} ${MONTHS_GENITIVE[d.month - 1]}`;
}

/** "пт, 13 листопада" (рік додається, лише якщо він не поточний). */
export function formatDate(d: Ymd, today?: Ymd): string {
  const base = `${WEEKDAYS_SHORT[weekdayOf(d) - 1]}, ${d.day} ${MONTHS_GENITIVE[d.month - 1]}`;
  return today && today.year !== d.year ? `${base} ${d.year}` : base;
}

/** Підпис дедлайну: "пт, 13 листопада о 18:00" або "пт, 13 листопада, до кінця дня". */
export function formatMoment(epochSec: number, tz: string, allDay: boolean, nowSec: number): string {
  const p = localParts(epochSec, tz);
  const today = ymdOf(localParts(nowSec, tz));
  const date = formatDate(ymdOf(p), today);
  return allDay ? `${date}, до кінця дня` : `${date} о ${formatMinutes(p.hour * 60 + p.minute)}`;
}

/**
 * Відносний підпис: "через 40 хв", "через 5 год", "завтра", "через 3 дні",
 * "прострочено на 2 дні". Дні рахуються календарно в поясі користувача.
 */
export function relativeLabel(epochSec: number, tz: string, nowSec: number, allDay = false): string {
  const diff = epochSec - nowSec;
  const dayDiff = daysBetween(ymdOf(localParts(nowSec, tz)), ymdOf(localParts(epochSec, tz)));
  if (diff < 0) {
    const overdueDays = -dayDiff;
    if (overdueDays >= 1) return `прострочено на ${overdueDays} ${plural(overdueDays, ['день', 'дні', 'днів'])}`;
    const h = Math.floor(-diff / 3600);
    return h >= 1 ? `прострочено на ${h} ${plural(h, ['годину', 'години', 'годин'])}` : 'щойно минув';
  }
  if (dayDiff === 0 && allDay) return 'сьогодні';
  if (diff < 3600) {
    const m = Math.max(1, Math.round(diff / 60));
    return `через ${m} хв`;
  }
  if (dayDiff === 0 || diff < 6 * 3600) {
    const h = Math.round(diff / 3600);
    return `через ${h} ${plural(h, ['годину', 'години', 'годин'])}`;
  }
  if (dayDiff === 1) return 'завтра';
  if (dayDiff === 2) return 'післязавтра';
  return `через ${dayDiff} ${plural(dayDiff, ['день', 'дні', 'днів'])}`;
}

/** Тривалість у хвилинах словами: "45 хв", "2 год", "1 год 30 хв". */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} хв`;
  return m ? `${h} год ${m} хв` : `${h} год`;
}
