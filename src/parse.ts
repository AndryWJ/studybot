/**
 * Розбір дедлайнів і занять із вільного тексту українською, без ШІ.
 *
 * Розуміє типові формулювання: "25.11 18:00 реферат", "здати курсову до 15 грудня",
 * "контрольна з фізики в четвер о 10", "через 2 години подзвонити", "пн, ср 15:00-16:00
 * англійська". Усе, що не вдалося розібрати тут, бот за потреби віддає ШІ.
 */

import {
  addDays,
  isValidYmd,
  localParts,
  parseClock,
  ymdOf,
  zonedToEpoch,
  type Ymd,
} from './time';

/** Дедлайн, знайдений у тексті. `due`: unix-секунди UTC. */
export interface ParsedDeadline {
  title: string;
  due: number;
  /** Час не вказано: дедлайн до кінця дня (23:59). */
  allDay: boolean;
}

/** Заняття з розкладу. Час у хвилинах від півночі. */
export interface ParsedLesson {
  weekdays: number[];
  start: number;
  end: number | null;
  title: string;
}

const L = "a-zа-яіїєґ'";
const B = `(?<![${L}\\d])`;
const A = `(?![${L}\\d])`;
const PREP = `(?:(?:до|на|в|у|о|об|з|по|від|к)\\s+)?`;
/** Прийменники перед датою. Без "о" і "об": "о 9.05" означає час, а не 9 травня. */
const PREP_DATE = `(?:(?:до|на|в|у|з|по|від|к)\\s+)?`;

const MONTH_STEMS = ['січ', 'лют', 'берез', 'квіт', 'трав', 'черв', 'лип', 'серп', 'верес', 'жовт', 'листоп', 'груд'];
const WEEKDAY_TOKEN =
  "пн|вт|ср|чт|пт|сб|нд|понеділ[" + L + "]*|вівтор[" + L + "]*|середа|середу|середи|четвер[" + L + "]*|" +
  "п'?ятниц[" + L + "]*|п'?ятн|субот[" + L + "]*|неділ[" + L + "]*|mon|tue|wed|thu|fri|sat|sun";
const NUMBER_WORDS: Record<string, number> = { один: 1, одну: 1, два: 2, дві: 2, три: 3, чотири: 4, "п'ять": 5 };

/** Номер дня тижня (1 понеділок ... 7 неділя) за словом чи скороченням. */
function weekdayFromToken(token: string): number | null {
  const t = token.toLowerCase();
  const table: Array<[RegExp, number]> = [
    [/^(пн|понеділ|mon)/, 1],
    [/^(вт|вівтор|tue)/, 2],
    [/^(ср|серед|wed)/, 3],
    [/^(чт|четвер|thu)/, 4],
    [/^(пт|п'?ятн|fri)/, 5],
    [/^(сб|субот|sat)/, 6],
    [/^(нд|неділ|sun)/, 7],
  ];
  for (const [re, n] of table) if (re.test(t)) return n;
  return null;
}

/**
 * Нижній регістр і єдиний апостроф без зміни довжини рядка, щоб позиції збігів
 * у нормалізованому тексті відповідали позиціям в оригіналі.
 */
function normalize(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '’' || ch === 'ʼ' || ch === '`' || ch === '‘') {
      out += "'";
      continue;
    }
    const low = ch.toLowerCase();
    out += low.length === ch.length ? low : ch;
  }
  return out;
}

class Scanner {
  readonly spans: Array<[number, number]> = [];
  private work: string;

  constructor(readonly original: string) {
    this.work = normalize(original);
  }

  /** Перший збіг, для якого `accept` повертає true; знайдений фрагмент вилучається з подальшого пошуку. */
  take(re: RegExp, accept: (m: RegExpExecArray) => boolean = () => true): RegExpExecArray | null {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(this.work)) !== null) {
      if (m[0].length === 0) {
        g.lastIndex++;
        continue;
      }
      if (accept(m)) {
        this.spans.push([m.index, m.index + m[0].length]);
        this.work = this.work.slice(0, m.index) + ' '.repeat(m[0].length) + this.work.slice(m.index + m[0].length);
        return m;
      }
    }
    return null;
  }

  /** Текст оригіналу без вилучених фрагментів. */
  rest(): string {
    let out = '';
    let pos = 0;
    for (const [s, e] of [...this.spans].sort((a, b) => a[0] - b[0])) {
      out += this.original.slice(pos, s) + ' ';
      pos = Math.max(pos, e);
    }
    return out + this.original.slice(pos);
  }
}

/** Година з уточненням частини доби: "о 9 вечора" це 21, "о 11 ночі" це 23, "о 2 ночі" це 2. */
function applyDayPart(hour: number, part: string | undefined): number {
  if (!part) return hour;
  if (part === 'вечора' && hour < 12) return hour + 12;
  if (part === 'дня' && hour >= 1 && hour <= 6) return hour + 12;
  if (part === 'ночі' && hour >= 8 && hour <= 11) return hour + 12;
  if (part === 'ночі' && hour === 12) return 0;
  return hour;
}

/**
 * Найближча майбутня (або сьогоднішня) дата з таким днем і місяцем, якщо рік не
 * вказано: 29.02 потрапить на найближчий високосний рік. Із явним роком дата лише
 * перевіряється на існування.
 */
function resolveDate(day: number, month: number, explicitYear: number | null, today: Ymd): Ymd | null {
  if (explicitYear !== null) {
    const d = { year: explicitYear, month, day };
    return isValidYmd(d) ? d : null;
  }
  for (let year = today.year; year <= today.year + 4; year++) {
    const d = { year, month, day };
    if (isValidYmd(d) && compare(d, today) >= 0) return d;
  }
  return null;
}

function yearOf(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  return raw.length === 2 ? 2000 + Number(raw) : Number(raw);
}

function addMonths(d: Ymd, months: number): Ymd {
  const total = d.year * 12 + (d.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day: Math.min(d.day, lastDay) };
}

/** Прибирає службові слова на краях назви і робить першу літеру великою. */
export function cleanTitle(raw: string): string {
  let t = raw.replace(/\s+/g, ' ').trim();
  const lead = /^(?:будь\s+ласка|нагадай(?:те)?|нагадування|дедлайн|deadline|треба|потрібно|мені|що|про|і|й|та|[,.:;!\-\u2013\u2014])(?=[\s,.:;!]|$)/i;
  const tail = /(?:\s+|^)(?:до|на|в|у|о|об|і|й|та|з|по|к|від|[,.:;\-\u2013\u2014])$/i;
  for (let i = 0; i < 6; i++) {
    const next = t.replace(lead, '').replace(tail, '').replace(/^[\s,.:;\-\u2013\u2014]+|[\s,:;\-\u2013\u2014]+$/g, '').trim();
    if (next === t) break;
    t = next;
  }
  return t ? (t[0].toUpperCase() + t.slice(1)).slice(0, 100).trim() : '';
}

/**
 * Шукає в тексті дату і (необов'язково) час дедлайну.
 *
 * Повертає null, якщо дати чи часу немає зовсім. Дата без року, що вже минула
 * цього року, переноситься на наступний. Час без дати означає сьогодні, а якщо
 * він уже минув, то завтра. Минулий момент повертається як є: перевіряє викликач.
 */
export function parseDeadline(text: string, nowSec: number, tz: string): ParsedDeadline | null {
  const source = text.trim().slice(0, 500);
  if (!source) return null;
  const sc = new Scanner(source);
  const now = localParts(nowSec, tz);
  const today = ymdOf(now);

  let exact: number | null = null;
  let date: Ymd | null = null;
  let weekday: { wd: number; next: boolean } | null = null;
  let time: number | null = null;

  const rel = sc.take(
    new RegExp(
      `${B}через\\s+(\\d{1,3}(?:[.,]\\d)?|пів)?\\s*(хвилин[уи]?|хв\\.?|годин[уи]?|год\\.?)(?:\\s+(?:і\\s+)?(\\d{1,2})\\s*(?:хвилин[уи]?|хв\\.?))?${A}`,
    ),
  );
  if (rel) {
    const n = rel[1] === undefined ? 1 : rel[1] === 'пів' ? 0.5 : Number(rel[1].replace(',', '.'));
    const unit = rel[2].startsWith('х') ? 60 : 3600;
    const extra = rel[3] !== undefined && unit === 3600 ? Number(rel[3]) * 60 : 0;
    exact = Math.round((nowSec + n * unit + extra) / 60) * 60;
  }

  if (exact === null) {
    const relDays = sc.take(
      new RegExp(
        `${B}через\\s+(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})?\\s*(день|дні|днів|тиждень|тижні|тижнів|місяць|місяці|місяців)${A}`,
      ),
    );
    if (relDays) {
      const raw = relDays[1];
      const n = raw === undefined ? 1 : (NUMBER_WORDS[raw] ?? Number(raw));
      const unit = relDays[2];
      if (unit.startsWith('місяц')) date = addMonths(today, n);
      else date = addDays(today, unit.startsWith('тиж') ? n * 7 : n);
    }
  }

  const dayPart = `(?:\\s+(ранку|вечора|дня|ночі))?`;
  if (exact === null) {
    const dotted = sc.take(new RegExp(`${B}(?:о|об)\\s+([01]?\\d|2[0-3])\\.([0-5]\\d)${A}${dayPart}`));
    if (dotted) time = applyDayPart(Number(dotted[1]), dotted[3]) * 60 + Number(dotted[2]);
  }

  if (exact === null && !date) {
    const numeric = sc.take(
      new RegExp(`${B}${PREP_DATE}(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{4}|\\d{2}))?(?![\\d:])`),
      (m) => resolveDate(Number(m[1]), Number(m[2]), yearOf(m[3]), today) !== null,
    );
    if (numeric) date = resolveDate(Number(numeric[1]), Number(numeric[2]), yearOf(numeric[3]), today);
  }

  if (exact === null && !date) {
    const named = sc.take(
      new RegExp(
        `${B}${PREP}(\\d{1,2})\\s+(${MONTH_STEMS.join('|')})[${L}]*\\.?(?:\\s+(\\d{4})(?:\\s*(?:р\\.|року|рік))?)?${A}`,
      ),
      (m) => resolveDate(Number(m[1]), MONTH_STEMS.indexOf(m[2]) + 1, yearOf(m[3]), today) !== null,
    );
    if (named) date = resolveDate(Number(named[1]), MONTH_STEMS.indexOf(named[2]) + 1, yearOf(named[3]), today);
  }

  if (exact === null && !date) {
    const word = sc.take(new RegExp(`${B}${PREP}(сьогодні|завтра|післязавтра)${A}`));
    if (word) date = addDays(today, word[1] === 'сьогодні' ? 0 : word[1] === 'завтра' ? 1 : 2);
  }

  if (exact === null && !date) {
    const wd = sc.take(
      new RegExp(
        `${B}(?:(наступн[${L}]*)\\s+)?${PREP}(?:(?:цю|цей|цього|цієї)\\s+)?(?:(наступн[${L}]*)\\s+)?(${WEEKDAY_TOKEN})${A}`,
      ),
    );
    if (wd) {
      const n = weekdayFromToken(wd[3]);
      if (n) weekday = { wd: n, next: Boolean(wd[1] || wd[2]) };
    }
  }

  if (exact === null && time === null) {
    const hourWord = `(?:\\s*(?:год\\.?|годин[іиу]?))?`;
    const clock =
      sc.take(new RegExp(`${B}${PREP}([01]?\\d|2[0-3]):([0-5]\\d)${A}${dayPart}`)) ??
      // "18.00" після вже знайденої дати чи там, де друге число не може бути місяцем, це час.
      sc.take(
        new RegExp(`${B}${PREP}([01]?\\d|2[0-3])\\.([0-5]\\d)${A}${dayPart}`),
        (m) => date !== null || weekday !== null || Number(m[2]) > 12 || m[2] === '00',
      );
    if (clock) {
      time = applyDayPart(Number(clock[1]), clock[3]) * 60 + Number(clock[2]);
    } else {
      const at = sc.take(new RegExp(`${B}(?:о|об)\\s+(\\d{1,2})${hourWord}${dayPart}${A}`), (m) => Number(m[1]) <= 24);
      const until =
        at ??
        sc.take(
          new RegExp(`${B}(?:до|в|у)\\s+(\\d{1,2})(?:\\s*(?:год\\.?|годин[іиу]?)${dayPart}|\\s+(ранку|вечора|дня|ночі))${A}`),
          (m) => Number(m[1]) <= 24,
        ) ??
        sc.take(new RegExp(`${B}(?:до|в|у)\\s+(\\d{1,2})(?=\\s*(?:$|[,.!?;)]))`), (m) => Number(m[1]) <= 24) ??
        sc.take(new RegExp(`${B}(\\d{1,2})\\s*(?:год\\.?|годині)${dayPart}${A}`), (m) => Number(m[1]) <= 24);
      if (until) {
        const h = Number(until[1]);
        const part = until[2] ?? until[3];
        time = h === 24 ? 23 * 60 + 59 : applyDayPart(h, part) * 60;
      } else {
        const special = sc.take(new RegExp(`${B}${PREP}(опівдні|опівночі)${A}`));
        if (special) time = special[1] === 'опівдні' ? 12 * 60 : 23 * 60 + 59;
      }
    }
  }

  const title = cleanTitle(sc.rest()) || 'Дедлайн';

  if (exact !== null) return { title, due: exact, allDay: false };

  if (weekday) {
    const cur = now.weekday;
    let delta = (weekday.wd - cur + 7) % 7;
    if (delta === 0) {
      const laterToday = time !== null && time > now.hour * 60 + now.minute;
      if (!laterToday) delta = 7;
    }
    if (weekday.next && cur + delta <= 7) delta += 7;
    date = addDays(today, delta);
  }

  if (!date && time === null) return null;

  if (!date) {
    const nowMin = now.hour * 60 + now.minute;
    date = time! > nowMin ? today : addDays(today, 1);
  }

  if (time === null) {
    return { title, due: zonedToEpoch(date.year, date.month, date.day, 23, 59, tz), allDay: true };
  }
  return {
    title,
    due: zonedToEpoch(date.year, date.month, date.day, Math.floor(time / 60), time % 60, tz),
    allDay: false,
  };
}

function compare(a: Ymd, b: Ymd): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/**
 * Розбирає заняття, по одному на рядок: "пн 08:30-09:15 Математика",
 * "вт, чт 15:00 Англійська", "пн-пт 8.30 Зарядка", "щодня 20:00 Читання".
 * Повертає розібрані заняття і рядки, які розібрати не вдалося.
 */
export function parseLessons(text: string): { lessons: ParsedLesson[]; bad: string[] } {
  const lessons: ParsedLesson[] = [];
  const bad: string[] = [];
  for (const rawLine of text.split(/[\n;]+/)) {
    const line = rawLine.trim().slice(0, 300);
    if (!line) continue;
    for (const part of splitLessonLine(line)) {
      const parsed = parseLessonLine(part);
      if (parsed) lessons.push(parsed);
      else bad.push(part);
    }
  }
  return { lessons, bad };
}

const HAS_TIME = /\d{1,2}[:.]\d{2}/;

/**
 * Ділить рядок із кількома заняттями через кому ("пн 8:30 Математика, вт 9:00 Фізика")
 * на окремі заняття. Частини без часу приєднуються до наступної ("вт, чт 15:00 ..."),
 * а хвіст без часу повертається до попередньої (кома в назві).
 */
function splitLessonLine(line: string): string[] {
  const pieces = line.split(/,\s*/);
  if (pieces.length < 2 || pieces.filter((p) => HAS_TIME.test(p)).length < 2) return [line];
  const out: string[] = [];
  let pending = '';
  for (const piece of pieces) {
    pending = pending ? `${pending}, ${piece}` : piece;
    if (HAS_TIME.test(piece)) {
      out.push(pending);
      pending = '';
    }
  }
  if (pending) {
    if (out.length) out[out.length - 1] += `, ${pending}`;
    else out.push(pending);
  }
  return out;
}

function parseLessonLine(line: string): ParsedLesson | null {
  const sc = new Scanner(line);
  const days = new Set<number>();

  const everyDay = sc.take(new RegExp(`${B}(щодня|щоденно|кожного\\s+дня|кожен\\s+день)${A}`));
  if (everyDay) [1, 2, 3, 4, 5, 6, 7].forEach((d) => days.add(d));
  const weekdays = sc.take(new RegExp(`${B}(?:по\\s+)?(будні|буднях|будній|робочі\\s+дні)${A}`));
  if (weekdays) [1, 2, 3, 4, 5].forEach((d) => days.add(d));
  const weekend = sc.take(new RegExp(`${B}(?:у|в|на)?\\s*(вихідні|вихідних)${A}`));
  if (weekend) [6, 7].forEach((d) => days.add(d));

  let range: RegExpExecArray | null;
  while ((range = sc.take(new RegExp(`${B}(${WEEKDAY_TOKEN})\\s*[-\\u2013\\u2014]\\s*(${WEEKDAY_TOKEN})${A}`))) !== null) {
    const from = weekdayFromToken(range[1]);
    const to = weekdayFromToken(range[2]);
    if (from && to) {
      for (let d = from; ; d = (d % 7) + 1) {
        days.add(d);
        if (d === to) break;
      }
    }
  }
  let single: RegExpExecArray | null;
  while ((single = sc.take(new RegExp(`${B}(?:(?:у|в|по)\\s+)?(${WEEKDAY_TOKEN})${A}`))) !== null) {
    const d = weekdayFromToken(single[1]);
    if (d) days.add(d);
  }
  if (days.size === 0) return null;

  const t = sc.take(
    new RegExp(`${B}(?:(?:о|об|з)\\s+)?(\\d{1,2}[:.]\\d{2})(?:\\s*(?:[-\\u2013\\u2014]|до)\\s*(\\d{1,2}[:.]\\d{2}))?${A}`),
    (m) => parseClock(m[1]) !== null && (m[2] === undefined || parseClock(m[2]) !== null),
  );
  if (!t) return null;
  const start = parseClock(t[1])!;
  const endRaw = t[2] !== undefined ? parseClock(t[2]) : null;
  const end = endRaw !== null && endRaw > start ? endRaw : null;

  const title = cleanTitle(sc.rest().replace(/^[\s,]+/, ''));
  if (!title) return null;
  return { weekdays: [...days].sort((a, b) => a - b), start, end, title: title.slice(0, 100) };
}

/**
 * Тривалість заняття з тексту: "45 хв", "1.5 год", "1 год 20 хв", "1:20",
 * "півтори години". Решта тексту (без тривалості) повертається як `rest`,
 * зазвичай це назва предмета. Повертає null, якщо тривалості немає або вона
 * довша за 16 годин.
 */
export function parseDuration(text: string): { minutes: number; rest: string } | null {
  const sc = new Scanner(text.trim().slice(0, 200));
  let minutes = 0;
  const clock = sc.take(new RegExp(`${B}(\\d{1,2}):([0-5]\\d)${A}`));
  if (clock) minutes = Number(clock[1]) * 60 + Number(clock[2]);
  else {
    const word = sc.take(new RegExp(`${B}(півтори|пів)\\s*годин[иу]?${A}`));
    if (word) minutes += word[1] === 'півтори' ? 90 : 30;
    const hours = sc.take(new RegExp(`${B}(\\d+(?:[.,]\\d+)?)\\s*(?:год[${L}]*\\.?|h)${A}`));
    if (hours) minutes += Math.round(Number(hours[1].replace(',', '.')) * 60);
    else if (!word && sc.take(new RegExp(`${B}годину${A}`))) minutes += 60;
    const mins = sc.take(new RegExp(`${B}(\\d+)\\s*(?:хв[${L}]*\\.?|min|m)${A}`));
    if (mins) minutes += Number(mins[1]);
  }
  if (minutes <= 0 || minutes > 16 * 60) return null;
  return { minutes, rest: cleanTitle(sc.rest()) };
}

/**
 * Вільний час на тиждень з тексту: "будні 2, вихідні 3", "пн-пт 1.5 год, сб 4, нд 0",
 * "щодня 90 хв". Числа без одиниць означають години. Дні, яких немає в тексті,
 * беруться з `base`. Повертає null, якщо не розібрано жодного дня.
 */
export function parseWeeklyHours(text: string, base: number[]): number[] | null {
  const out = [...base];
  const low = normalize(text.slice(0, 300));
  const dayGroup = `(${WEEKDAY_TOKEN})(?:\\s*[-\\u2013\\u2014]\\s*(${WEEKDAY_TOKEN}))?|будні|буднях|вихідні|вихідних|щодня|щоденно|кожного\\s+дня|кожен\\s+день`;
  const re = new RegExp(`${B}(?:${dayGroup})${A}|(\\d+(?:[.,]\\d+)?)\\s*(год[${L}]*|хв[${L}]*)?`, 'g');
  // Дні накопичуються, доки не трапиться число: "пн, вт 2" задає 2 години обом дням.
  let pending: number[] = [];
  let found = false;
  for (const m of low.matchAll(re)) {
    if (m[3] !== undefined) {
      if (!pending.length) continue;
      const value = Number(m[3].replace(',', '.'));
      const minutes = m[4]?.startsWith('хв') ? Math.round(value) : Math.round(value * 60);
      if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 16 * 60) {
        for (const d of pending) out[d - 1] = minutes;
        found = true;
      }
      pending = [];
      continue;
    }
    const group = m[0];
    if (/^(будні|буднях)/.test(group)) pending.push(1, 2, 3, 4, 5);
    else if (/^(вихідні|вихідних)/.test(group)) pending.push(6, 7);
    else if (/^(щодня|щоденно|кожного|кожен)/.test(group)) pending.push(1, 2, 3, 4, 5, 6, 7);
    else {
      const from = weekdayFromToken(m[1]);
      const to = m[2] ? weekdayFromToken(m[2]) : from;
      if (from && to) {
        for (let d = from; ; d = (d % 7) + 1) {
          pending.push(d);
          if (d === to) break;
        }
      }
    }
  }
  return found ? out : null;
}
