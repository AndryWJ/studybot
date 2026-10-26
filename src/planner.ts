/**
 * Алгоритми планування без ШІ: скільки годин дати кожному предмету, як
 * розкласти заняття по вільних днях до іспитів, як розподілити кроки завдання
 * до дедлайну і що робити першим.
 *
 * Усе тут чисті функції (без бази й мережі), тому їх легко перевіряти тестами.
 * Час у хвилинах, дати як Ymd або рядки 'YYYY-MM-DD'.
 */

import { addDays, compareYmd, daysBetween, weekdayOf, ymdToString, type Ymd } from './time';

/** Вільний час за замовчуванням, хвилин на день: пн-пт по 2 год, сб 3 год, нд 1 год. */
export const DEFAULT_AVAILABILITY = [120, 120, 120, 120, 120, 180, 60];

/** Розбирає збережений JSON вільного часу; при помилці повертає типовий. */
export function parseAvailability(json: string | null): number[] {
  if (!json) return [...DEFAULT_AVAILABILITY];
  try {
    const v = JSON.parse(json);
    if (Array.isArray(v) && v.length === 7 && v.every((n) => Number.isFinite(n) && n >= 0 && n <= 16 * 60)) return v.map(Math.round);
  } catch {
    // типовий нижче
  }
  return [...DEFAULT_AVAILABILITY];
}

/** Предмет для плану підготовки. */
export interface SubjectInput {
  name: string;
  /** Складність предмета: 1 легко ... 5 дуже важко. */
  difficulty: number;
  /** Рівень підготовки: 1 слабкий ... 5 сильний. */
  level: number;
  /** День іспиту; заняття ставляться лише на дні до нього. null: без іспиту. */
  exam: Ymd | null;
}

/**
 * Вага предмета при розподілі годин: складність, помножена на "прогалину" в
 * знаннях (6 мінус рівень). Від 1 (легкий предмет, сильний рівень) до 25.
 */
export function subjectWeight(s: Pick<SubjectInput, 'difficulty' | 'level'>): number {
  const d = clamp(Math.round(s.difficulty), 1, 5);
  const l = clamp(Math.round(s.level), 1, 5);
  return d * (6 - l);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Ділить `total` хвилин між предметами пропорційно вагам, кратно `block` хвилинам,
 * методом найбільших залишків: сума частин дорівнює `total`, округленому вниз до `block`.
 */
export function splitByWeights(total: number, weights: number[], block = 30): number[] {
  const blocks = Math.floor(Math.max(0, total) / block);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length || sum <= 0 || blocks === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (blocks * w) / sum);
  const base = raw.map(Math.floor);
  let left = blocks - base.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r), w: weights[i] }))
    // Дробові частини порівнюються з допуском: 6.5454...6 і 14.5454...5 мають рівні залишки.
    .sort((a, b) => (Math.abs(b.frac - a.frac) > 1e-9 ? b.frac - a.frac : b.w - a.w || a.i - b.i));
  for (const { i } of order) {
    if (left <= 0) break;
    base[i]++;
    left--;
  }
  return base.map((b) => b * block);
}

/** Заняття з одного предмета протягом дня, `minutes` хвилин. */
export interface PlanSession {
  subject: string;
  minutes: number;
}

/** День плану; `date`: 'YYYY-MM-DD'. */
export interface PlanDay {
  date: string;
  sessions: PlanSession[];
}

/** Підсумок по предмету: скільки часу йому належало і скільки розкладено. */
export interface SubjectAllocation {
  name: string;
  weight: number;
  /** Скільки хвилин предмету належить за вагою. */
  target: number;
  /** Скільки вдалося поставити в розклад до іспиту. */
  scheduled: number;
  exam: string | null;
}

/** Результат buildStudyPlan. У `days` лише дні із заняттями, за зростанням дати. */
export interface StudyPlan {
  subjects: SubjectAllocation[];
  days: PlanDay[];
  /** Сумарний вільний час у межах плану, хвилин. */
  capacity: number;
  /** Скільки хвилин план мав розподілити. */
  budget: number;
  warnings: string[];
}

/** Параметри buildStudyPlan. */
export interface PlanOptions {
  /** Загальний бюджет часу, хвилин; null означає "весь вільний час". */
  budget: number | null;
  /** Хвилин на день тижня, [пн..нд]. */
  availability: number[];
  /** Перший день плану (зазвичай сьогодні). */
  from: Ymd;
  /** Уже зайняті хвилини за датами (заняття інших планів). */
  busy?: Record<string, number>;
  /** Кратність занять, хвилин. */
  block?: number;
  /** Найбільше хвилин одного предмета за день, щоб предмети чергувалися. */
  maxPerSubjectDay?: number;
  /** Скільки днів планувати для предметів без дати іспиту. */
  defaultHorizon?: number;
  /** Найдовший горизонт плану в днях. */
  maxHorizon?: number;
}

function formatHours(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} хв`;
  return m ? `${h} год ${m} хв` : `${h} год`;
}

/**
 * Будує план підготовки.
 *
 * 1. Рахує вільний час по днях до останнього іспиту (мінус уже зайнятий іншими планами).
 * 2. Ділить бюджет між предметами за вагою (subjectWeight): складніший предмет
 *    і слабша підготовка дають більше годин.
 * 3. Розтягує години кожного предмета рівномірно на дні до його іспиту, а потім
 *    добирає з вільних хвилин те, що не влізло.
 *    День за днем заповнює час блоками: першим іде предмет, у якого
 *    найбільше незакритих годин відносно вільного часу, що лишився до його
 *    іспиту (принцип "найменшого запасу"), тож ранній іспит не лишається без часу.
 *    Один предмет займає не більше `maxPerSubjectDay` хвилин на день, крім випадку,
 *    коли з таким темпом він не встигає до свого іспиту.
 * 4. Години, що не вміщаються до іспиту свого предмета, передаються предметам
 *    із пізнішими іспитами (за вагою). Так дата іспиту впливає на розподіл,
 *    коли часу мало.
 * 5. Якщо бюджет не задано, вільні хвилини, що лишилися, роздає предметам,
 *    яким до їхньої частки бракує найбільше.
 * Нестачу часу, якої не вдалося покрити, описують попередження.
 */
export function buildStudyPlan(subjectsIn: SubjectInput[], opts: PlanOptions): StudyPlan {
  const block = opts.block ?? 30;
  const maxPerDay = opts.maxPerSubjectDay ?? 120;
  const warnings: string[] = [];
  const from = opts.from;

  const subjects = subjectsIn.filter((s) => {
    if (s.exam && compareYmd(s.exam, from) <= 0) {
      warnings.push(`${s.name}: дата іспиту вже настала, предмет не враховано.`);
      return false;
    }
    return true;
  });
  if (!subjects.length) return { subjects: [], days: [], capacity: 0, budget: 0, warnings };

  const latestExam = subjects.reduce<Ymd | null>((acc, s) => (s.exam && (!acc || compareYmd(s.exam, acc) > 0) ? s.exam : acc), null);
  const allHaveExam = subjects.every((s) => s.exam);
  const defaultEnd = addDays(from, opts.defaultHorizon ?? 28);
  let horizonEnd = latestExam && (allHaveExam || compareYmd(latestExam, defaultEnd) > 0) ? latestExam : defaultEnd;
  const maxEnd = addDays(from, opts.maxHorizon ?? 210);
  if (compareYmd(horizonEnd, maxEnd) > 0) {
    horizonEnd = maxEnd;
    warnings.push(`План розписано на ${opts.maxHorizon ?? 210} днів наперед; ближче до іспиту його варто оновити.`);
  }
  const ends = subjects.map((s) => (s.exam && compareYmd(s.exam, horizonEnd) < 0 ? s.exam : horizonEnd));
  const dayCount = daysBetween(from, horizonEnd);

  const dates: string[] = [];
  const cap: number[] = [];
  for (let i = 0; i < dayCount; i++) {
    const d = addDays(from, i);
    const key = ymdToString(d);
    dates.push(key);
    const free = opts.availability[weekdayOf(d) - 1] ?? 0;
    cap.push(Math.max(0, Math.floor((free - (opts.busy?.[key] ?? 0)) / block) * block));
  }
  const endIdx = ends.map((e) => daysBetween(from, e));
  // suffix[i]: вільний час від дня i до кінця горизонту (за початковими даними).
  const suffix = new Array<number>(dayCount + 1).fill(0);
  for (let i = dayCount - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + cap[i];
  const capacityUntil = (subject: number, day: number) => Math.max(0, suffix[day] - suffix[Math.min(endIdx[subject], dayCount)]);

  const capacity = suffix[0];
  if (capacity === 0) warnings.push('У налаштуваннях немає вільного часу на навчання до іспитів. Додай години в ⚙️ Налаштування.');

  let budget = opts.budget ?? capacity;
  if (opts.budget !== null && opts.budget > capacity) {
    warnings.push(`Хочеш ${formatHours(opts.budget)}, а вільного часу до іспитів лише ${formatHours(capacity)}: план розрахований на весь вільний час.`);
    budget = capacity;
  }

  const weights = subjects.map(subjectWeight);
  const targets = splitByWeights(budget, weights, block);
  const remaining = [...targets];
  const scheduled = subjects.map(() => 0);
  const free = [...cap];
  const plan: Array<Map<number, number>> = dates.map(() => new Map());
  const all = subjects.map((_, i) => i);

  /**
   * Заповнює вільні хвилини дня, але не більше `allowance`; `score` обирає предмет
   * для кожного блоку, а `overCap` вирішує, чи можна дати предмету більше денного ліміту
   * (`othersUnderCap` каже, чи є цього дня інші предмети, що ще не досягли ліміту).
   */
  const fillDay = (
    day: number,
    wants: (i: number) => boolean,
    score: (i: number, usedToday: number) => number,
    overCap: (i: number, othersUnderCap: boolean) => boolean,
    allowance = free[day],
  ) => {
    let usedToday = cap[day] - free[day];
    let spent = 0;
    while (free[day] >= block && spent + block <= allowance) {
      const eligible = all.filter((i) => day < endIdx[i] && wants(i));
      if (!eligible.length) break;
      const underCap = eligible.filter((i) => (plan[day].get(i) ?? 0) + block <= maxPerDay);
      const candidates = eligible.filter((i) => underCap.includes(i) || overCap(i, underCap.length > 0));
      if (!candidates.length) break;
      let best = candidates[0];
      let bestScore = score(best, usedToday);
      for (const i of candidates.slice(1)) {
        const sc = score(i, usedToday);
        if (sc > bestScore + 1e-9 || (Math.abs(sc - bestScore) <= 1e-9 && weights[i] > weights[best])) {
          best = i;
          bestScore = sc;
        }
      }
      plan[day].set(best, (plan[day].get(best) ?? 0) + block);
      scheduled[best] += block;
      remaining[best] -= block;
      free[day] -= block;
      usedToday += block;
      spent += block;
    }
  };

  // Рівномірний темп: години кожного предмета розтягуються на дні до його іспиту,
  // щоб за великого запасу часу заняття не збивалися в перші дні.
  const quota = new Array<number>(dayCount).fill(0);
  let carry = 0;
  for (let d = 0; d < dayCount; d++) {
    for (const i of all) if (d < endIdx[i]) carry += targets[i] / Math.max(1, endIdx[i]);
    const q = Math.min(cap[d], Math.max(0, Math.round(carry / block) * block));
    quota[d] = q;
    carry -= q;
  }

  const leastSlack = (i: number, usedToday: number) => {
    // Скільки вільного часу лишилося до іспиту предмета, з урахуванням уже зайнятого сьогодні.
    return remaining[i] / Math.max(1, capacityUntil(i, currentDay) - usedToday);
  };
  let currentDay = 0;
  // Понад денний ліміт можна, лише коли з лімітом предмет не встигає до свого іспиту:
  // його незакритих годин більше, ніж уміщають наступні дні до іспиту по денному ліміту.
  const mustCatchUp = (i: number) => {
    let later = 0;
    for (let d = currentDay + 1; d < endIdx[i]; d++) later += Math.min(free[d], maxPerDay);
    return remaining[i] > later;
  };
  // У рівномірному проході першим іде предмет, що найбільше відстає від свого темпу:
  // так предмети чергуються, а ранній іспит однаково отримує свої години вчасно.
  const behindPace = (i: number, usedToday: number) => {
    // Захист від запізнення: якщо предметам з іспитами до певної дати разом уже ледь
    // вистачає вільного часу, вони йдуть першими, у порядку іспитів.
    for (const k of all) {
      if (endIdx[i] > endIdx[k]) continue;
      const need = all.reduce((a, j) => a + (endIdx[j] <= endIdx[k] ? Math.max(0, remaining[j]) : 0), 0);
      if (need >= capacityUntil(k, currentDay) - usedToday) return 1e6 - endIdx[i];
    }
    return ((scheduled[i] + remaining[i]) * (currentDay + 1)) / Math.max(1, endIdx[i]) - scheduled[i];
  };
  const targetPass = (paced: boolean) => {
    for (currentDay = 0; currentDay < dayCount; currentDay++) {
      const allowance = paced ? Math.max(0, quota[currentDay] - (cap[currentDay] - free[currentDay])) : free[currentDay];
      fillDay(currentDay, (i) => remaining[i] > 0, paced ? behindPace : leastSlack, mustCatchUp, allowance);
    }
  };

  targetPass(true);
  // Те, що не влізло в рівномірний темп (округлення, вихідні без вільного часу), добираємо з вільних хвилин.
  targetPass(false);
  const moved = subjects.map(() => 0);
  for (let round = 0; round < 3; round++) {
    const stuck = all.filter((i) => remaining[i] >= block);
    if (!stuck.length) break;
    const takers = all.filter((i) => !stuck.includes(i) && free.some((f, d) => d < endIdx[i] && f >= block));
    const spare = stuck.reduce((a, i) => a + remaining[i], 0);
    if (!takers.length) break;
    const extra = splitByWeights(spare, takers.map((i) => weights[i]), block);
    if (extra.every((x) => x === 0)) break;
    for (const i of stuck) {
      moved[i] += remaining[i];
      remaining[i] = 0;
    }
    takers.forEach((i, k) => (remaining[i] += extra[k]));
    targetPass(false);
  }

  if (opts.budget === null) {
    for (let day = 0; day < dayCount; day++) {
      // Залишок віддаємо предмету, якому до його ваги не вистачає найбільше.
      currentDay = day;
      fillDay(day, () => true, (i) => -scheduled[i] / weights[i], (_, othersUnderCap) => !othersUnderCap);
    }
  } else {
    subjects.forEach((s, i) => {
      const until = s.exam ? 'іспиту' : 'кінця плану';
      if (remaining[i] >= block) {
        warnings.push(`${s.name}: до ${until} не вмістилося ${formatHours(remaining[i])}. Додай вільного часу або зменш обсяг.`);
      } else if (moved[i] >= block) {
        warnings.push(`${s.name}: до ${until} вміщається лише ${formatHours(scheduled[i])}, тож ще ${formatHours(moved[i])} віддано іншим предметам.`);
      }
    });
  }

  const days: PlanDay[] = [];
  plan.forEach((m, day) => {
    if (!m.size) return;
    const sessions = [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([i, minutes]) => ({ subject: subjects[i].name, minutes }));
    days.push({ date: dates[day], sessions });
  });

  return {
    subjects: subjects.map((s, i) => ({
      name: s.name,
      weight: weights[i],
      target: opts.budget === null ? scheduled[i] : targets[i],
      scheduled: scheduled[i],
      exam: s.exam ? ymdToString(s.exam) : null,
    })),
    days,
    capacity,
    budget,
    warnings,
  };
}

/** Результат allocateSteps. */
export interface StepAllocation {
  /** Дата кожного кроку, 'YYYY-MM-DD'. */
  dates: string[];
  /**
   * Скільки хвилин понад вільний час доводиться на дні до дедлайну (0, якщо кроки влізли).
   * Крок, довший за весь вільний час дня, сам по собі перевищенням не вважається.
   */
  overload: number;
}

/**
 * Розкладає кроки завдання по вільних днях від `from` до дня перед дедлайном
 * (або до самого дедлайну, якщо він сьогодні чи завтра). Кроки йдуть по порядку
 * і не діляться між днями. Без дедлайну кроки розкладаються наперед без обмеження.
 * Якщо кроки не пакуються у вільний час, вони розподіляються рівномірно до дедлайну,
 * а `overload` показує нестачу: загальну або на окремих переповнених днях, якщо вона більша.
 */
export function allocateSteps(
  minutes: Array<number | null>,
  from: Ymd,
  due: Ymd | null,
  availability: number[],
  busy: Record<string, number> = {},
  defaultMinutes = 45,
): StepAllocation {
  const need = minutes.map((m) => (m && m > 0 ? m : defaultMinutes));
  const lastDay = due ? (daysBetween(from, due) >= 2 ? addDays(due, -1) : due) : addDays(from, 120);
  const span = Math.max(0, daysBetween(from, lastDay));
  const used: Record<string, number> = {};
  const dates: string[] = [];
  let day = 0;
  let fits = true;

  const freeOn = (offset: number) => {
    const d = addDays(from, offset);
    const key = ymdToString(d);
    return { key, free: (availability[weekdayOf(d) - 1] ?? 0) - (busy[key] ?? 0) - (used[key] ?? 0) };
  };

  const anyFree = availability.some((m) => m > 0);
  for (const m of need) {
    let placed = false;
    while (anyFree && day <= span) {
      const { key, free } = freeOn(day);
      const nominal = availability[weekdayOf(addDays(from, day)) - 1] ?? 0;
      // Крок, довший за звичайний вільний час дня, ставимо на перший день, де ще нічого немає.
      if (free >= m || (m > nominal && free > 0 && (used[key] ?? 0) === 0 && (busy[key] ?? 0) === 0)) {
        used[key] = (used[key] ?? 0) + m;
        dates.push(key);
        placed = true;
        break;
      }
      day++;
    }
    if (!placed) {
      fits = false;
      break;
    }
  }

  if (fits) return { dates, overload: 0 };

  // Скільки хвилин можна поставити на день: вільний час, а для дня без зайнятого часу
  // ще й один крок, довший за звичайний вільний час дня (як і при пакуванні вище).
  const allowed = (offset: number, longest: number) => {
    const d = addDays(from, offset);
    const key = ymdToString(d);
    const nominal = availability[weekdayOf(d) - 1] ?? 0;
    const free = Math.max(0, nominal - (busy[key] ?? 0));
    return longest > nominal && !busy[key] ? Math.max(free, longest) : free;
  };
  let capacity = 0;
  for (let i = 0; i <= span; i++) capacity += allowed(i, 0);
  const total = need.reduce((a, b) => a + b, 0);
  const offsets = need.map((_, i) => (need.length === 1 ? span : Math.round((i * span) / (need.length - 1))));
  // Неподільні кроки можуть переповнити окремі дні, навіть коли загального часу вистачає.
  const onDay = new Map<number, { sum: number; longest: number }>();
  offsets.forEach((offset, i) => {
    const slot = onDay.get(offset) ?? { sum: 0, longest: 0 };
    slot.sum += need[i];
    slot.longest = Math.max(slot.longest, need[i]);
    onDay.set(offset, slot);
  });
  let crowded = 0;
  for (const [offset, slot] of onDay) crowded += Math.max(0, slot.sum - allowed(offset, slot.longest));
  const even = offsets.map((offset) => ymdToString(addDays(from, offset)));
  return { dates: even, overload: Math.max(0, total - capacity, crowded) };
}

/**
 * Пріоритет дедлайну: (2 × важливість + складність) × терміновість, де
 * терміновість = 1 / (днів до дедлайну + 1), а для простроченого 2.
 * Важливість і складність від 1 до 3.
 */
export function priorityScore(importance: number, difficulty: number, due: number, now: number): number {
  const daysLeft = (due - now) / 86400;
  const urgency = daysLeft < 0 ? 2 : 1 / (daysLeft + 1);
  return (2 * clamp(importance, 1, 3) + clamp(difficulty, 1, 3)) * urgency;
}

/** Рівень пріоритету дедлайну. */
export type PriorityLevel = 'high' | 'medium' | 'low';

/** Рівень за оцінкою priorityScore: від 3 висока, від 1 середня, нижче низька. */
export function priorityLevel(score: number): PriorityLevel {
  if (score >= 3) return 'high';
  if (score >= 1) return 'medium';
  return 'low';
}

/** Позначка рівня пріоритету: червона, жовта, зелена. */
export const PRIORITY_ICON: Record<PriorityLevel, string> = { high: '🔴', medium: '🟡', low: '🟢' };
