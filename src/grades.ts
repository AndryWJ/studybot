/**
 * Аналіз оцінок: середній бал (зважений), розбір введених оцінок і розрахунок,
 * які оцінки потрібні, щоб вийти на бажану підсумкову.
 *
 * Підсумкова оцінка вважається середнім, округленим до цілого за правилом
 * "половина вгору": щоб вийшло 10, середній має бути не менше 9,5.
 * Вчитель може враховувати й інше, тож це орієнтир, а не гарантія.
 */

/** Найвища оцінка шкали: 12-бальна, 5-бальна чи 100-бальна. */
export type GradeScale = 12 | 5 | 100;

/** Усі підтримувані шкали. */
export const SCALES: GradeScale[] = [12, 5, 100];

/** Оцінка з предмета; `weight`: вага (1 для звичайної). */
export interface GradeEntry {
  subject: string;
  value: number;
  weight: number;
}

/** Статистика по предмету; `average` зважений: sum / weightSum. */
export interface SubjectStats {
  subject: string;
  count: number;
  /** Сума оцінок, помножених на вагу. */
  sum: number;
  weightSum: number;
  average: number;
}

/** Найнижча допустима оцінка шкали: 0 для 100-бальної, інакше 1. */
export function minGrade(scale: GradeScale): number {
  return scale === 100 ? 0 : 1;
}

/** Середній бал по кожному предмету, від найнижчого до найвищого. */
export function subjectStats(grades: GradeEntry[]): SubjectStats[] {
  const map = new Map<string, SubjectStats>();
  for (const g of grades) {
    const key = g.subject.toLowerCase();
    const s = map.get(key) ?? { subject: g.subject, count: 0, sum: 0, weightSum: 0, average: 0 };
    s.count++;
    s.sum += g.value * g.weight;
    s.weightSum += g.weight;
    map.set(key, s);
  }
  return [...map.values()]
    .map((s) => ({ ...s, average: s.weightSum ? s.sum / s.weightSum : 0 }))
    .sort((a, b) => a.average - b.average || a.subject.localeCompare(b.subject, 'uk'));
}

/** Загальний середній як середнє предметних середніх (кожен предмет важить однаково). */
export function overallAverage(stats: SubjectStats[]): number | null {
  if (!stats.length) return null;
  return stats.reduce((a, s) => a + s.average, 0) / stats.length;
}

/** Середній, округлений до цілого "половина вгору". */
export function roundedGrade(avg: number): number {
  return Math.floor(avg + 0.5 + 1e-9);
}

/** Що потрібно, щоб вийти на бажану підсумкову оцінку, див. targetPlan. */
export interface TargetPlan {
  /** Поріг середнього, з якого округлення дає бажану оцінку. */
  threshold: number;
  /** Середній уже не нижчий за поріг. */
  reached: boolean;
  /** Бажана оцінка недосяжна навіть одними максимальними оцінками. */
  impossible: boolean;
  /** Скільки максимальних оцінок поспіль треба, щоб вийти на поріг. */
  maxGradesNeeded: number | null;
  /** Для 1, 2, 3... наступних оцінок: який середній з них потрібен (лише досяжні варіанти). */
  options: Array<{ count: number; neededAverage: number }>;
}

/**
 * Які оцінки потрібні, щоб середній досяг `target` після округлення.
 * Нові оцінки рахуються з вагою 1. `maxCount`: скільки варіантів показати.
 */
export function targetPlan(stats: Pick<SubjectStats, 'sum' | 'weightSum'>, target: number, scale: GradeScale, maxCount = 5): TargetPlan {
  const threshold = Math.max(minGrade(scale), target - 0.5);
  const current = stats.weightSum ? stats.sum / stats.weightSum : 0;
  if (stats.weightSum > 0 && current >= threshold - 1e-9) {
    return { threshold, reached: true, impossible: false, maxGradesNeeded: 0, options: [] };
  }
  if (threshold > scale) return { threshold, reached: false, impossible: true, maxGradesNeeded: null, options: [] };

  let maxGradesNeeded: number | null;
  if (scale - threshold < 1e-9) {
    maxGradesNeeded = stats.weightSum === 0 ? 1 : null;
  } else {
    maxGradesNeeded = Math.max(1, Math.ceil((threshold * stats.weightSum - stats.sum) / (scale - threshold) - 1e-9));
  }
  const options: Array<{ count: number; neededAverage: number }> = [];
  for (let k = 1; k <= maxCount; k++) {
    const needed = (threshold * (stats.weightSum + k) - stats.sum) / k;
    if (needed <= scale + 1e-9) options.push({ count: k, neededAverage: Math.max(minGrade(scale), needed) });
  }
  return { threshold, reached: false, impossible: maxGradesNeeded === null, maxGradesNeeded, options };
}

/**
 * Розбирає оцінки з тексту, по предмету на рядок: "Математика 10 11 9",
 * "фізика: 8, 7x2" (x2 це вага 2, наприклад, за контрольну), "Англійська 12".
 * Кома розділяє оцінки, дробову частину пишуть через крапку (для 100-бальної шкали).
 * Повертає розібрані оцінки й рядки з помилками (оцінка поза шкалою чи без предмета).
 */
export function parseGrades(text: string, scale: GradeScale): { grades: GradeEntry[]; bad: string[] } {
  const grades: GradeEntry[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[\n;]+/)) {
    const line = raw.trim().slice(0, 300);
    if (!line) continue;
    // Токени справа наліво: поки токен схожий на оцінку ("10", "7x2"), це оцінка,
    // решта зліва це назва предмета. Без регулярного виразу з вкладеними повтореннями.
    const tokens = line
      .replace(/[.,;:\s]+$/, '')
      .replace(/\s*([xх×*])\s*(?=\d)/gi, '$1')
      .split(/[\s,;:]+/)
      .filter(Boolean);
    const values: Array<{ value: number; weight: number }> = [];
    let k = tokens.length;
    while (k > 0) {
      const m = /^(\d{1,3}(?:\.\d{1,2})?)(?:[xх×*](\d{1,2}(?:\.\d)?))?$/i.exec(tokens[k - 1]);
      if (!m) break;
      values.unshift({ value: Number(m[1]), weight: m[2] === undefined ? 1 : Number(m[2]) });
      k--;
    }
    const subject = tokens.slice(0, k).join(' ').replace(/[\s:,;-]+$/, '').trim().slice(0, 40);
    const ok =
      values.length > 0 &&
      /[^\d\s]/.test(subject) &&
      values.every((g) => g.value >= minGrade(scale) && g.value <= scale && g.weight > 0 && g.weight <= 10);
    if (!ok) {
      bad.push(line);
      continue;
    }
    const name = subject[0].toUpperCase() + subject.slice(1);
    grades.push(...values.map((g) => ({ subject: name, value: g.value, weight: g.weight })));
  }
  return { grades, bad };
}

/** Число з комою як у Україні: 9.456 дає "9,46". */
export function formatGrade(n: number, digits = 2): string {
  return (Math.round(n * 10 ** digits) / 10 ** digits).toString().replace('.', ',');
}
