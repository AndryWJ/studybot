/**
 * Тести чистих алгоритмів src/planner.ts (години по предметах, план по днях,
 * розкладання кроків, пріоритети) і src/grades.ts (середні, цільова оцінка,
 * розбір введених оцінок). База й мережа тут не потрібні.
 */

import { describe, expect, it } from 'vitest';
import {
  allocateSteps,
  buildStudyPlan,
  DEFAULT_AVAILABILITY,
  parseAvailability,
  priorityLevel,
  priorityScore,
  splitByWeights,
  subjectWeight,
  type PlanOptions,
  type StudyPlan,
  type SubjectInput,
} from '../../src/planner';
import {
  formatGrade,
  minGrade,
  overallAverage,
  parseGrades,
  roundedGrade,
  SCALES,
  subjectStats,
  targetPlan,
  type GradeEntry,
  type GradeScale,
} from '../../src/grades';
import { addDays, daysBetween, parseYmd, weekdayOf, ymdToString, type Ymd } from '../../src/time';

/** Неділя, 2026-10-25. */
const FROM: Ymd = { year: 2026, month: 10, day: 25 };
const FLAT = [120, 120, 120, 120, 120, 120, 120];

function ymd(s: string): Ymd {
  const p = parseYmd(s);
  if (!p) throw new Error(`bad date ${s}`);
  return p;
}

function inDays(n: number): Ymd {
  return addDays(FROM, n);
}

function subject(name: string, difficulty: number, level: number, exam: Ymd | null): SubjectInput {
  return { name, difficulty, level, exam };
}

function totalMinutes(plan: StudyPlan, name?: string): number {
  let sum = 0;
  for (const d of plan.days) for (const s of d.sessions) if (!name || s.subject === name) sum += s.minutes;
  return sum;
}

function dayTotal(plan: StudyPlan, date: string): number {
  return plan.days.find((d) => d.date === date)?.sessions.reduce((a, s) => a + s.minutes, 0) ?? 0;
}

/** Перевіряє властивості, що мають виконуватися для будь-якого плану. */
function expectPlanInvariants(plan: StudyPlan, subjects: SubjectInput[], opts: PlanOptions) {
  const block = opts.block ?? 30;
  const exams = new Map(subjects.map((s) => [s.name, s.exam]));
  for (const day of plan.days) {
    const dayDate = ymd(day.date);
    expect(daysBetween(opts.from, dayDate)).toBeGreaterThanOrEqual(0);
    const free = opts.availability[weekdayOf(dayDate) - 1] - (opts.busy?.[day.date] ?? 0);
    expect(day.sessions.reduce((a, s) => a + s.minutes, 0)).toBeLessThanOrEqual(Math.max(0, free));
    const seen = new Set<string>();
    for (const s of day.sessions) {
      expect(seen.has(s.subject)).toBe(false);
      seen.add(s.subject);
      expect(s.minutes % block).toBe(0);
      expect(s.minutes).toBeGreaterThan(0);
      // Денний ліміт на предмет м'який: його перевищують, коли інакше предмет не встигає
      // до іспиту, або коли план добирає весь вільний час (budget: null). Тому тут він
      // не перевіряється; для нього є окремі тести.
      const exam = exams.get(s.subject);
      if (exam) expect(daysBetween(dayDate, exam)).toBeGreaterThanOrEqual(1);
    }
  }
  for (const a of plan.subjects) expect(totalMinutes(plan, a.name)).toBe(a.scheduled);
}

describe('parseAvailability', () => {
  it('returns a copy of the defaults for null, empty and invalid input', () => {
    for (const bad of [null, '', 'not json', '{}', '[1,2,3]', '[120,120,120,120,120,120,-1]', '[120,120,120,120,120,120,961]', '["1",2,3,4,5,6,7]']) {
      const v = parseAvailability(bad);
      expect(v).toEqual(DEFAULT_AVAILABILITY);
      expect(v).not.toBe(DEFAULT_AVAILABILITY);
    }
  });

  it('accepts seven finite numbers in range and rounds them', () => {
    expect(parseAvailability('[0,30.4,60.6,90,120,960,10]')).toEqual([0, 30, 61, 90, 120, 960, 10]);
  });
});

describe('subjectWeight', () => {
  it('multiplies difficulty by the knowledge gap', () => {
    expect(subjectWeight({ difficulty: 5, level: 2 })).toBe(20);
    expect(subjectWeight({ difficulty: 3, level: 3 })).toBe(9);
    expect(subjectWeight({ difficulty: 2, level: 4 })).toBe(4);
  });

  it('stays between 1 and 25 for every valid input', () => {
    for (let d = 1; d <= 5; d++) {
      for (let l = 1; l <= 5; l++) {
        const w = subjectWeight({ difficulty: d, level: l });
        expect(w).toBeGreaterThanOrEqual(1);
        expect(w).toBeLessThanOrEqual(25);
      }
    }
    expect(subjectWeight({ difficulty: 1, level: 5 })).toBe(1);
    expect(subjectWeight({ difficulty: 5, level: 1 })).toBe(25);
  });

  it('clamps and rounds out-of-range values', () => {
    expect(subjectWeight({ difficulty: 99, level: -4 })).toBe(25);
    expect(subjectWeight({ difficulty: 0, level: 99 })).toBe(1);
    expect(subjectWeight({ difficulty: 2.6, level: 3.4 })).toBe(subjectWeight({ difficulty: 3, level: 3 }));
  });
});

describe('splitByWeights', () => {
  it('sums exactly to the block-rounded total', () => {
    const cases: Array<[number, number[], number]> = [
      [720, [20, 9, 4], 30],
      [725, [20, 9, 4], 30],
      [100, [1, 1], 30],
      [1000, [3, 7, 11, 13], 15],
      [59, [5, 5], 30],
      [600, [1, 1, 1], 30],
    ];
    for (const [total, weights, block] of cases) {
      const parts = splitByWeights(total, weights, block);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(Math.floor(total / block) * block);
      for (const p of parts) expect(p % block).toBe(0);
    }
  });

  it('keeps each part within one block of the exact proportional share', () => {
    const weightSets = [[20, 9, 4], [1, 2, 3, 4, 5], [25, 1], [7, 7, 7, 7], [13, 1, 1]];
    for (const weights of weightSets) {
      for (const total of [30, 90, 330, 720, 1234, 5000]) {
        const parts = splitByWeights(total, weights, 30);
        const blocksTotal = Math.floor(total / 30) * 30;
        const sum = weights.reduce((a, b) => a + b, 0);
        parts.forEach((p, i) => {
          const exact = (blocksTotal * weights[i]) / sum;
          expect(Math.abs(p - exact)).toBeLessThan(30);
        });
      }
    }
  });

  it('splits the reference twelve hours in proportion 20:9:4', () => {
    const parts = splitByWeights(720, [20, 9, 4]);
    expect(parts[0]).toBeGreaterThan(parts[1]);
    expect(parts[1]).toBeGreaterThan(parts[2]);
    // Залишки 14,545 і 6,545 рівні, тож додатковий блок отримує предмет із більшою вагою.
    expect(parts).toEqual([450, 180, 90]);
  });

  it('gives the leftover block to the largest remainder', () => {
    expect(splitByWeights(600, [10, 20, 30])).toEqual([90, 210, 300]);
  });

  it('breaks equal remainders by weight, then by index', () => {
    expect(splitByWeights(60, [1, 3])).toEqual([0, 60]);
    expect(splitByWeights(90, [1, 1])).toEqual([60, 30]);
    expect(splitByWeights(90, [1, 1, 1, 1, 1, 1])).toEqual([30, 30, 30, 0, 0, 0]);
  });

  it('returns zeros for zero weights, empty input or less than one block', () => {
    expect(splitByWeights(600, [0, 0, 0])).toEqual([0, 0, 0]);
    expect(splitByWeights(600, [])).toEqual([]);
    expect(splitByWeights(29, [1, 2])).toEqual([0, 0]);
    expect(splitByWeights(-100, [1, 2])).toEqual([0, 0]);
  });

  it('gives nothing to a zero weight among positive ones', () => {
    expect(splitByWeights(120, [0, 5])).toEqual([0, 120]);
  });

  it('honours a custom block size', () => {
    const parts = splitByWeights(100, [1, 1], 25);
    expect(parts).toEqual([50, 50]);
    expect(splitByWeights(100, [1, 1, 1], 20).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('buildStudyPlan: reference example of 12 hours for three subjects', () => {
  const subjects = [
    subject('Математика', 5, 2, inDays(10)),
    subject('Фізика', 3, 3, inDays(14)),
    subject('Англійська', 2, 4, inDays(20)),
  ];
  const opts: PlanOptions = { budget: 720, availability: FLAT, from: FROM };
  const plan = buildStudyPlan(subjects, opts);

  it('schedules exactly twelve hours with no warnings', () => {
    expect(plan.budget).toBe(720);
    expect(totalMinutes(plan)).toBe(720);
    expect(plan.subjects.reduce((a, s) => a + s.scheduled, 0)).toBe(720);
    expect(plan.warnings).toEqual([]);
  });

  it('gives harder and weaker subjects more time', () => {
    const [m, f, a] = plan.subjects;
    expect([m.name, f.name, a.name]).toEqual(['Математика', 'Фізика', 'Англійська']);
    expect(m.scheduled).toBeGreaterThan(f.scheduled);
    expect(f.scheduled).toBeGreaterThan(a.scheduled);
    expect([m.target, f.target, a.target]).toEqual([450, 180, 90]);
    expect([m.scheduled, f.scheduled, a.scheduled]).toEqual([450, 180, 90]);
    expect([m.weight, f.weight, a.weight]).toEqual([20, 9, 4]);
  });

  it('reports exam dates as YYYY-MM-DD', () => {
    expect(plan.subjects.map((s) => s.exam)).toEqual([ymdToString(inDays(10)), ymdToString(inDays(14)), ymdToString(inDays(20))]);
  });

  it('never schedules a subject on or after its exam day', () => {
    for (const day of plan.days) {
      for (const s of day.sessions) {
        const exam = subjects.find((x) => x.name === s.subject)!.exam!;
        expect(daysBetween(ymd(day.date), exam)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('keeps the plan chronological with sessions sorted by minutes', () => {
    const dates = plan.days.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
    for (const d of plan.days) {
      const mins = d.sessions.map((s) => s.minutes);
      expect([...mins].sort((x, y) => y - x)).toEqual(mins);
    }
  });

  it('satisfies the generic plan invariants', () => {
    expectPlanInvariants(plan, subjects, opts);
  });
});

describe('buildStudyPlan: capacity rules', () => {
  it('never exceeds availability minus busy minutes on any day', () => {
    const subjects = [subject('Математика', 5, 1, inDays(12)), subject('Фізика', 4, 2, inDays(15)), subject('Історія', 3, 3, null)];
    const busy: Record<string, number> = {
      [ymdToString(inDays(1))]: 60,
      [ymdToString(inDays(2))]: 120,
      [ymdToString(inDays(3))]: 45,
      [ymdToString(inDays(5))]: 500,
    };
    const opts: PlanOptions = { budget: null, availability: DEFAULT_AVAILABILITY, from: FROM, busy };
    const plan = buildStudyPlan(subjects, opts);
    expectPlanInvariants(plan, subjects, opts);
    expect(dayTotal(plan, ymdToString(inDays(2)))).toBe(0);
    expect(dayTotal(plan, ymdToString(inDays(5)))).toBe(0);
    expect(dayTotal(plan, ymdToString(inDays(1)))).toBeLessThanOrEqual(60);
  });

  it('uses the availability of the right weekday', () => {
    const onlySunday = [0, 0, 0, 0, 0, 0, 60];
    const plan = buildStudyPlan([subject('Історія', 3, 3, null)], { budget: null, availability: onlySunday, from: FROM });
    expect(plan.days.length).toBeGreaterThan(0);
    for (const d of plan.days) expect(weekdayOf(ymd(d.date))).toBe(7);
    expect(plan.days[0].date).toBe('2026-10-25');
    expect(plan.days[0].sessions).toEqual([{ subject: 'Історія', minutes: 60 }]);
  });

  it('subtracts busy minutes and rounds the remainder down to whole blocks', () => {
    const subjects = [subject('Історія', 3, 3, null)];
    const busy = {
      [ymdToString(inDays(1))]: 120,
      [ymdToString(inDays(2))]: 90,
      [ymdToString(inDays(3))]: 100,
      [ymdToString(inDays(4))]: 400,
    };
    const base = buildStudyPlan(subjects, { budget: null, availability: FLAT, from: FROM });
    const plan = buildStudyPlan(subjects, { budget: null, availability: FLAT, from: FROM, busy });
    expect(base.capacity).toBe(28 * 120);
    expect(plan.capacity).toBe(base.capacity - 120 - 90 - 120 - 120);
    expect(dayTotal(plan, ymdToString(inDays(1)))).toBe(0);
    expect(dayTotal(plan, ymdToString(inDays(2)))).toBe(30);
    expect(dayTotal(plan, ymdToString(inDays(3)))).toBe(0);
    expect(dayTotal(plan, ymdToString(inDays(4)))).toBe(0);
  });

  it('respects the per-subject per-day cap so subjects alternate', () => {
    const subjects = [subject('А', 3, 3, null), subject('Б', 3, 3, null)];
    const opts: PlanOptions = { budget: 480, availability: FLAT, from: FROM, maxPerSubjectDay: 60 };
    const plan = buildStudyPlan(subjects, opts);
    expectPlanInvariants(plan, subjects, opts);
    expect(totalMinutes(plan)).toBe(480);
    for (const d of plan.days) for (const s of d.sessions) expect(s.minutes).toBeLessThanOrEqual(60);
    // За великого запасу часу план розтягується рівномірно, а не забиває перші дні.
    expect(plan.days.length).toBeGreaterThan(7);
  });

  it('applies the default cap of two hours per subject per day', () => {
    const plan = buildStudyPlan([subject('А', 3, 3, null)], { budget: 600, availability: [300, 300, 300, 300, 300, 300, 300], from: FROM });
    for (const d of plan.days) for (const s of d.sessions) expect(s.minutes).toBeLessThanOrEqual(120);
    expect(totalMinutes(plan)).toBe(600);
  });

  it('honours a custom block size', () => {
    const subjects = [subject('А', 3, 3, null), subject('Б', 2, 2, null)];
    const opts: PlanOptions = { budget: 300, availability: FLAT, from: FROM, block: 15 };
    const plan = buildStudyPlan(subjects, opts);
    expectPlanInvariants(plan, subjects, opts);
    expect(totalMinutes(plan)).toBe(300);
  });

  it('plans only for defaultHorizon days when there are no exams', () => {
    const plan = buildStudyPlan([subject('А', 3, 3, null)], { budget: null, availability: FLAT, from: FROM, defaultHorizon: 7 });
    expect(plan.capacity).toBe(7 * 120);
    const last = plan.days[plan.days.length - 1].date;
    expect(daysBetween(FROM, ymd(last))).toBeLessThanOrEqual(6);
  });
});

describe('buildStudyPlan: ordering under tight capacity', () => {
  it('gives the earliest exam its hours first', () => {
    const subjects = [subject('Пізній', 3, 3, inDays(10)), subject('Ранній', 3, 3, inDays(2))];
    const opts: PlanOptions = { budget: 480, availability: FLAT, from: FROM };
    const plan = buildStudyPlan(subjects, opts);
    expectPlanInvariants(plan, subjects, opts);
    expect(plan.warnings).toEqual([]);
    expect(plan.subjects.find((s) => s.name === 'Ранній')!.scheduled).toBe(240);
    expect(plan.subjects.find((s) => s.name === 'Пізній')!.scheduled).toBe(240);
    expect(plan.days[0].sessions).toEqual([{ subject: 'Ранній', minutes: 120 }]);
    expect(plan.days[1].sessions).toEqual([{ subject: 'Ранній', minutes: 120 }]);
    const late = plan.days.flatMap((d) => d.sessions.filter((s) => s.subject === 'Пізній').map((s) => ({ date: d.date, minutes: s.minutes })));
    expect(late.every((x) => daysBetween(FROM, ymd(x.date)) >= 2)).toBe(true);
    // Решта годин пізнішого предмета розтягнута на дні до його іспиту.
    expect(Math.max(...late.map((x) => x.minutes))).toBeLessThanOrEqual(60);
  });

  it('serves subjects by exam order when the budget equals the capacity before the last exam', () => {
    const subjects = [
      subject('С', 3, 3, inDays(6)),
      subject('А', 3, 3, inDays(2)),
      subject('В', 3, 3, inDays(4)),
    ];
    const opts: PlanOptions = { budget: 720, availability: FLAT, from: FROM };
    const plan = buildStudyPlan(subjects, opts);
    expectPlanInvariants(plan, subjects, opts);
    expect(plan.warnings).toEqual([]);
    expect(plan.subjects.map((s) => s.scheduled)).toEqual([240, 240, 240]);
    const firstTwoDays = plan.days.slice(0, 2).flatMap((d) => d.sessions.map((s) => s.subject));
    expect(new Set(firstTwoDays)).toEqual(new Set(['А']));
  });
});

describe('buildStudyPlan: warnings', () => {
  it('warns when the budget exceeds the free time and clamps it to the capacity', () => {
    const opts: PlanOptions = { budget: 100000, availability: [60, 60, 60, 60, 60, 60, 60], from: FROM };
    const plan = buildStudyPlan([subject('А', 3, 3, null)], opts);
    expect(plan.capacity).toBe(28 * 60);
    expect(plan.budget).toBe(plan.capacity);
    expect(plan.warnings.some((w) => w.includes('Хочеш'))).toBe(true);
    expect(totalMinutes(plan)).toBe(plan.capacity);
  });

  it('does not warn about capacity when the budget fits', () => {
    const plan = buildStudyPlan([subject('А', 3, 3, null)], { budget: 600, availability: FLAT, from: FROM });
    expect(plan.warnings).toEqual([]);
    expect(plan.budget).toBe(600);
  });

  it('warns when the requested hours do not fit before the only exam', () => {
    const plan = buildStudyPlan([subject('Хімія', 5, 1, inDays(3))], { budget: 600, availability: FLAT, from: FROM });
    expect(plan.subjects[0].scheduled).toBe(360);
    expect(plan.capacity).toBe(360);
    expect(plan.warnings.some((w) => w.includes('вільного часу до іспитів лише 6 год'))).toBe(true);
  });

  it('warns when one subject cannot get its share before an early exam', () => {
    const subjects = [subject('Хімія', 5, 1, inDays(2)), subject('Фізика', 2, 4, inDays(10))];
    const plan = buildStudyPlan(subjects, { budget: 600, availability: FLAT, from: FROM });
    const chem = plan.subjects.find((s) => s.name === 'Хімія')!;
    expect(chem.scheduled).toBe(240);
    expect(totalMinutes(plan)).toBe(600);
    expect(plan.warnings.some((w) => w.startsWith('Хімія') && w.includes('віддано іншим предметам'))).toBe(true);
  });

  it('warns about one subject only and still serves the others', () => {
    const subjects = [subject('Хімія', 5, 1, inDays(1)), subject('Історія', 1, 5, null)];
    const plan = buildStudyPlan(subjects, { budget: 600, availability: FLAT, from: FROM });
    const chem = plan.warnings.filter((w) => w.startsWith('Хімія'));
    expect(chem.length).toBe(1);
    expect(plan.warnings.some((w) => w.startsWith('Історія'))).toBe(false);
    expect(plan.subjects.find((s) => s.name === 'Історія')!.scheduled).toBeGreaterThan(0);
  });

  it('warns that there is no free time when availability is all zero', () => {
    const plan = buildStudyPlan([subject('А', 3, 3, inDays(5))], { budget: null, availability: [0, 0, 0, 0, 0, 0, 0], from: FROM });
    expect(plan.capacity).toBe(0);
    expect(plan.days).toEqual([]);
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(plan.warnings[0]).toContain('немає вільного часу');
  });

  it('warns about zero availability even with an explicit budget', () => {
    const plan = buildStudyPlan([subject('А', 3, 3, inDays(5))], { budget: 600, availability: [0, 0, 0, 0, 0, 0, 0], from: FROM });
    expect(plan.days).toEqual([]);
    expect(plan.budget).toBe(0);
    expect(plan.warnings.some((w) => w.includes('немає вільного часу'))).toBe(true);
  });

  it('warns when the horizon is capped by maxHorizon', () => {
    const subjects = [subject('А', 3, 3, inDays(100))];
    const plan = buildStudyPlan(subjects, { budget: 600, availability: FLAT, from: FROM, maxHorizon: 30 });
    expect(plan.warnings.some((w) => w.includes('30 днів'))).toBe(true);
    for (const d of plan.days) expect(daysBetween(FROM, ymd(d.date))).toBeLessThan(30);
    expect(plan.capacity).toBe(30 * 120);
  });

  it('does not warn about the horizon when the exam is inside it', () => {
    const plan = buildStudyPlan([subject('А', 3, 3, inDays(40))], { budget: 600, availability: FLAT, from: FROM, maxHorizon: 60 });
    expect(plan.warnings.some((w) => w.includes('днів наперед'))).toBe(false);
  });
});

describe('buildStudyPlan: exams already passed', () => {
  it('excludes a subject whose exam is today and warns', () => {
    const subjects = [subject('Сьогодні', 3, 3, FROM), subject('Інший', 3, 3, inDays(5))];
    const plan = buildStudyPlan(subjects, { budget: 300, availability: FLAT, from: FROM });
    expect(plan.subjects.map((s) => s.name)).toEqual(['Інший']);
    expect(plan.warnings.some((w) => w.startsWith('Сьогодні') && w.includes('іспиту'))).toBe(true);
    expect(totalMinutes(plan, 'Сьогодні')).toBe(0);
    expect(totalMinutes(plan, 'Інший')).toBe(300);
  });

  it('excludes a subject whose exam was yesterday', () => {
    const subjects = [subject('Вчора', 3, 3, inDays(-1)), subject('Інший', 3, 3, null)];
    const plan = buildStudyPlan(subjects, { budget: 300, availability: FLAT, from: FROM });
    expect(plan.subjects.map((s) => s.name)).toEqual(['Інший']);
    expect(plan.warnings.filter((w) => w.startsWith('Вчора')).length).toBe(1);
  });

  it('returns an empty plan with warnings when every exam has passed', () => {
    const plan = buildStudyPlan([subject('А', 3, 3, inDays(-3)), subject('Б', 3, 3, FROM)], { budget: 600, availability: FLAT, from: FROM });
    expect(plan.subjects).toEqual([]);
    expect(plan.days).toEqual([]);
    expect(plan.capacity).toBe(0);
    expect(plan.budget).toBe(0);
    expect(plan.warnings.length).toBe(2);
  });

  it('returns an empty plan for an empty subject list', () => {
    const plan = buildStudyPlan([], { budget: 600, availability: FLAT, from: FROM });
    expect(plan).toEqual({ subjects: [], days: [], capacity: 0, budget: 0, warnings: [] });
  });
});

describe('buildStudyPlan: budget null spends the free time', () => {
  const subjects = [
    subject('Математика', 5, 2, inDays(10)),
    subject('Фізика', 3, 3, inDays(14)),
    subject('Англійська', 2, 4, inDays(20)),
  ];
  const opts: PlanOptions = { budget: null, availability: FLAT, from: FROM };
  const plan = buildStudyPlan(subjects, opts);
  const usable = 20 * 120;

  it('fills every free minute before the last exam', () => {
    expect(totalMinutes(plan)).toBe(usable);
    for (let i = 0; i < 20; i++) expect(dayTotal(plan, ymdToString(inDays(i)))).toBe(120);
    expect(dayTotal(plan, ymdToString(inDays(20)))).toBe(0);
    expectPlanInvariants(plan, subjects, opts);
  });

  it('passes leftover capacity after early exams to later subjects', () => {
    const [m, f, a] = plan.subjects;
    const share = splitByWeights(usable, [20, 9, 4]);
    expect(m.scheduled).toBe(10 * 120);
    expect(f.scheduled).toBe(4 * 120);
    expect(a.scheduled).toBeGreaterThan(share[2]);
    expect(m.scheduled + f.scheduled + a.scheduled).toBe(usable);
  });

  it('reports the scheduled minutes as the target', () => {
    for (const s of plan.subjects) expect(s.target).toBe(s.scheduled);
  });

  it('reports a capacity that only counts days before the last exam', () => {
    expect(plan.capacity).toBe(usable);
    expect(plan.budget).toBe(usable);
  });

  it('does not warn about a shortfall when every free minute is used', () => {
    expect(plan.warnings).toEqual([]);
  });

  it('spends all capacity for a subject without an exam', () => {
    const p = buildStudyPlan([subject('Історія', 3, 3, null)], { budget: null, availability: FLAT, from: FROM, maxPerSubjectDay: 120 });
    expect(totalMinutes(p)).toBe(28 * 120);
    expect(p.warnings).toEqual([]);
  });
});

describe('buildStudyPlan: usable capacity before exams', () => {
  it('counts only the days before the last exam when every subject has one', () => {
    const plan = buildStudyPlan([subject('А', 3, 3, inDays(3))], { budget: 100, availability: FLAT, from: FROM });
    expect(plan.capacity).toBe(3 * 120);
  });

  it('warns when the budget exceeds the free time before the exams', () => {
    const plan = buildStudyPlan([subject('А', 3, 3, inDays(3))], { budget: 1000, availability: FLAT, from: FROM });
    expect(plan.warnings.some((w) => w.includes('Хочеш'))).toBe(true);
    expect(plan.budget).toBe(3 * 120);
  });
});

describe('allocateSteps', () => {
  const key = (n: number) => ymdToString(inDays(n));

  it('packs steps into days within availability and keeps their order', () => {
    const r = allocateSteps([60, 60, 60, 60], FROM, inDays(7), FLAT);
    expect(r.overload).toBe(0);
    expect(r.dates).toEqual([key(0), key(0), key(1), key(1)]);
  });

  it('never splits a step between days', () => {
    const r = allocateSteps([90, 60, 90], FROM, inDays(7), FLAT);
    expect(r.overload).toBe(0);
    expect(r.dates).toEqual([key(0), key(1), key(2)]);
  });

  it('keeps dates non-decreasing for many mixed steps', () => {
    const steps = [30, 45, 90, 20, 60, 15, 100, 40, 25, 70];
    const r = allocateSteps(steps, FROM, inDays(30), DEFAULT_AVAILABILITY);
    expect(r.overload).toBe(0);
    expect([...r.dates].sort()).toEqual(r.dates);
    const perDay = new Map<string, number>();
    r.dates.forEach((d, i) => perDay.set(d, (perDay.get(d) ?? 0) + steps[i]));
    for (const [date, used] of perDay) {
      expect(used).toBeLessThanOrEqual(DEFAULT_AVAILABILITY[weekdayOf(ymd(date)) - 1]);
    }
  });

  it('respects busy minutes', () => {
    const busy = { [key(0)]: 120, [key(1)]: 90 };
    const r = allocateSteps([60, 30, 30], FROM, inDays(7), FLAT, busy);
    expect(r.overload).toBe(0);
    expect(r.dates).toEqual([key(2), key(2), key(2)]);
  });

  it('reports overload when indivisible steps crowd a day although the total fits', () => {
    const r = allocateSteps([70, 70, 70, 70, 70], FROM, inDays(4), FLAT);
    expect(r.dates).toEqual([key(0), key(1), key(2), key(2), key(3)]);
    expect(r.overload).toBe(20);
  });

  it('does not count a lone step longer than the day as crowding in the even spread', () => {
    const r = allocateSteps([70, 70, 70, 70, 200], FROM, inDays(4), FLAT);
    expect(r.dates).toEqual([key(0), key(1), key(2), key(2), key(3)]);
    expect(r.overload).toBe(20);
  });

  it('puts a step longer than a whole day alone on a day', () => {
    const r = allocateSteps([60, 200, 60], FROM, inDays(10), FLAT);
    expect(r.overload).toBe(0);
    expect(r.dates).toEqual([key(0), key(1), key(2)]);
  });

  it('puts an oversized first step on the first day', () => {
    const r = allocateSteps([200, 30], FROM, inDays(10), FLAT);
    expect(r.overload).toBe(0);
    expect(r.dates).toEqual([key(0), key(1)]);
  });

  it('treats missing and zero durations as the default of 45 minutes', () => {
    const r = allocateSteps([null, 0, 30], FROM, inDays(5), FLAT);
    expect(r.overload).toBe(0);
    expect(r.dates).toEqual([key(0), key(0), key(0)]);
    const custom = allocateSteps([null, null], FROM, inDays(5), FLAT, {}, 90);
    expect(custom.dates).toEqual([key(0), key(1)]);
  });

  it('finishes the day before the deadline when it is two or more days away', () => {
    const r = allocateSteps([120, 120, 120, 120, 120], FROM, inDays(5), FLAT);
    expect(r.overload).toBe(0);
    expect(r.dates).toEqual([key(0), key(1), key(2), key(3), key(4)]);
    for (const d of r.dates) expect(d < key(5)).toBe(true);
  });

  it('may use the deadline day itself when it is tomorrow', () => {
    const r = allocateSteps([120, 120], FROM, inDays(1), FLAT);
    expect(r.overload).toBe(0);
    expect(r.dates).toEqual([key(0), key(1)]);
  });

  it('uses only today when the deadline is today', () => {
    const r = allocateSteps([60, 60], FROM, FROM, FLAT);
    expect(r.overload).toBe(0);
    expect(r.dates).toEqual([key(0), key(0)]);
  });

  it('spreads steps evenly and reports overload when time is short', () => {
    const r = allocateSteps([120, 120, 120], FROM, inDays(2), FLAT);
    expect(r.overload).toBe(120);
    expect(r.dates.length).toBe(3);
    expect(r.dates[0]).toBe(key(0));
    expect(r.dates[2]).toBe(key(1));
    expect([...r.dates].sort()).toEqual(r.dates);
  });

  it('reports the larger of the total shortfall and the overflow of crowded days', () => {
    const busy = { [key(0)]: 30 };
    const r = allocateSteps([100, 100, 100, 100], FROM, inDays(3), FLAT, busy);
    // Разом бракує 400 - (90 + 120 + 120) = 70 хв, але рівномірний розклад дає
    // 100 хв на день із 90 вільними і 200 хв на день із 120: це 10 + 80 хв понад вільний час.
    expect(r.overload).toBe(90);
    for (const d of r.dates) expect(d <= key(2)).toBe(true);
  });

  it('puts a lone overloaded step on the last allowed day', () => {
    const r = allocateSteps([60], FROM, inDays(3), [0, 0, 0, 0, 0, 0, 0]);
    expect(r.overload).toBe(60);
    expect(r.dates).toEqual([key(2)]);
  });

  it('reports full overload when there is no free time at all', () => {
    const r = allocateSteps([60, 30], FROM, inDays(10), [0, 0, 0, 0, 0, 0, 0]);
    expect(r.overload).toBe(90);
    expect(r.dates.length).toBe(2);
    expect(r.dates[0]).toBe(key(0));
    expect(r.dates[1]).toBe(key(9));
  });

  it('schedules forward without limits when there is no deadline', () => {
    const r = allocateSteps([120, 120, 120, 120, 120], FROM, null, FLAT);
    expect(r.overload).toBe(0);
    expect(r.dates).toEqual([key(0), key(1), key(2), key(3), key(4)]);
  });

  it('skips days with no availability when there is no deadline', () => {
    const saturdayOnly = [0, 0, 0, 0, 0, 120, 0];
    const r = allocateSteps([60, 60, 60], FROM, null, saturdayOnly);
    expect(r.overload).toBe(0);
    expect(r.dates).toEqual(['2026-10-31', '2026-10-31', '2026-11-07']);
  });

  it('returns no dates for no steps', () => {
    expect(allocateSteps([], FROM, inDays(5), FLAT)).toEqual({ dates: [], overload: 0 });
  });

  it('places everything today when the deadline has already passed and it fits', () => {
    const r = allocateSteps([60], FROM, inDays(-2), FLAT);
    expect(r.dates).toEqual([key(0)]);
    expect(r.overload).toBe(0);
  });
});

describe('priorityScore and priorityLevel', () => {
  const now = 1_800_000_000;
  const day = 86400;

  it('treats an overdue deadline as high priority', () => {
    const score = priorityScore(1, 1, now - 1, now);
    expect(priorityLevel(score)).toBe('high');
    expect(priorityLevel(priorityScore(1, 1, now - 30 * day, now))).toBe('high');
  });

  it('scores a closer deadline higher for equal importance and difficulty', () => {
    const scores = [0, 1, 2, 5, 10, 30].map((d) => priorityScore(2, 2, now + d * day, now));
    for (let i = 1; i < scores.length; i++) expect(scores[i - 1]).toBeGreaterThan(scores[i]);
  });

  it('ranks an overdue task above one due today', () => {
    expect(priorityScore(2, 2, now - 60, now)).toBeGreaterThan(priorityScore(2, 2, now, now));
  });

  it('weights importance more than difficulty', () => {
    const importantEasy = priorityScore(3, 1, now + 2 * day, now);
    const unimportantHard = priorityScore(1, 3, now + 2 * day, now);
    expect(importantEasy).toBeGreaterThan(unimportantHard);
    expect(priorityScore(3, 1, now + day, now)).toBeCloseTo((2 * 3 + 1) / 2, 10);
    expect(priorityScore(1, 3, now + day, now)).toBeCloseTo((2 * 1 + 3) / 2, 10);
  });

  it('clamps importance and difficulty to the range 1 to 3', () => {
    expect(priorityScore(10, 10, now, now)).toBe(priorityScore(3, 3, now, now));
    expect(priorityScore(-5, 0, now, now)).toBe(priorityScore(1, 1, now, now));
  });

  it('follows the documented formula', () => {
    expect(priorityScore(2, 2, now, now)).toBe(6);
    expect(priorityScore(2, 2, now + 2 * day, now)).toBe(2);
    expect(priorityScore(3, 3, now - day, now)).toBe(18);
  });

  it('maps scores to levels at the thresholds 3 and 1', () => {
    expect(priorityLevel(3)).toBe('high');
    expect(priorityLevel(2.999)).toBe('medium');
    expect(priorityLevel(1)).toBe('medium');
    expect(priorityLevel(0.999)).toBe('low');
    expect(priorityLevel(0)).toBe('low');
    expect(priorityLevel(100)).toBe('high');
  });

  it('puts a far, unimportant, easy task in the low level', () => {
    expect(priorityLevel(priorityScore(1, 1, now + 10 * day, now))).toBe('low');
  });

  it('puts a task due in a day with top importance in the high level', () => {
    expect(priorityLevel(priorityScore(3, 3, now + day, now))).toBe('high');
  });
});

describe('grades: minGrade and SCALES', () => {
  it('uses 0 as the minimum only on the 100 point scale', () => {
    expect(minGrade(100)).toBe(0);
    expect(minGrade(12)).toBe(1);
    expect(minGrade(5)).toBe(1);
    expect(SCALES).toEqual([12, 5, 100]);
  });
});

describe('subjectStats', () => {
  const g = (subject: string, value: number, weight = 1): GradeEntry => ({ subject, value, weight });

  it('computes weighted averages per subject', () => {
    const [s] = subjectStats([g('Математика', 10), g('Математика', 7, 2)]);
    expect(s.count).toBe(2);
    expect(s.sum).toBe(24);
    expect(s.weightSum).toBe(3);
    expect(s.average).toBe(8);
  });

  it('merges subjects case-insensitively and keeps the first spelling', () => {
    const stats = subjectStats([g('математика', 10), g('Математика', 8), g('МАТЕМАТИКА', 6)]);
    expect(stats.length).toBe(1);
    expect(stats[0].subject).toBe('математика');
    expect(stats[0].count).toBe(3);
    expect(stats[0].average).toBe(8);
  });

  it('merges Cyrillic subjects that differ only by case', () => {
    const stats = subjectStats([g('Українська мова', 9), g('українська мова', 11)]);
    expect(stats.length).toBe(1);
    expect(stats[0].average).toBe(10);
  });

  it('sorts from the lowest average to the highest', () => {
    const stats = subjectStats([g('А', 12), g('Б', 5), g('В', 9)]);
    expect(stats.map((s) => s.subject)).toEqual(['Б', 'В', 'А']);
  });

  it('breaks equal averages by subject name', () => {
    const stats = subjectStats([g('Фізика', 9), g('Алгебра', 9), g('Біологія', 9)]);
    expect(stats.map((s) => s.subject)).toEqual(['Алгебра', 'Біологія', 'Фізика']);
  });

  it('returns an empty list for no grades', () => {
    expect(subjectStats([])).toEqual([]);
  });
});

describe('overallAverage', () => {
  it('returns null for no subjects', () => {
    expect(overallAverage([])).toBeNull();
  });

  it('averages subject averages with equal weight per subject', () => {
    const grades: GradeEntry[] = [
      ...[6, 6, 6, 6, 6, 6, 6, 6, 6, 6].map((value) => ({ subject: 'Багато', value, weight: 1 })),
      { subject: 'Одна', value: 12, weight: 1 },
    ];
    expect(overallAverage(subjectStats(grades))).toBe(9);
  });

  it('equals the single subject average for one subject', () => {
    expect(overallAverage(subjectStats([{ subject: 'А', value: 8, weight: 1 }, { subject: 'А', value: 9, weight: 1 }]))).toBe(8.5);
  });
});

describe('roundedGrade', () => {
  it('rounds half up', () => {
    expect(roundedGrade(9.5)).toBe(10);
    expect(roundedGrade(7.5)).toBe(8);
    expect(roundedGrade(11.5)).toBe(12);
    expect(roundedGrade(9.49)).toBe(9);
    expect(roundedGrade(9.51)).toBe(10);
  });

  it('is tolerant to floating point noise just below a half', () => {
    expect(roundedGrade(9.5 - 1e-12)).toBe(10);
    expect(roundedGrade((9 + 10) / 2)).toBe(10);
    expect(roundedGrade(0.1 + 0.2 + 9.2)).toBe(roundedGrade(9.5));
  });

  it('keeps whole numbers and zero', () => {
    expect(roundedGrade(0)).toBe(0);
    expect(roundedGrade(12)).toBe(12);
    expect(roundedGrade(8)).toBe(8);
  });
});

describe('targetPlan', () => {
  const stats = (values: Array<[number, number]>) => ({
    sum: values.reduce((a, [v, w]) => a + v * w, 0),
    weightSum: values.reduce((a, [, w]) => a + w, 0),
  });

  /** Найменше k оцінок максимального балу, після яких середній не нижчий за поріг. */
  function bruteMaxGrades(s: { sum: number; weightSum: number }, threshold: number, scale: number): number | null {
    for (let k = 1; k <= 20000; k++) {
      if ((s.sum + k * scale) / (s.weightSum + k) >= threshold - 1e-9) return k;
    }
    return null;
  }

  it('reports reached when the average already rounds to the target', () => {
    const plan = targetPlan(stats([[10, 1], [10, 1], [10, 1]]), 10, 12);
    expect(plan).toEqual({ threshold: 9.5, reached: true, impossible: false, maxGradesNeeded: 0, options: [] });
  });

  it('treats an average exactly on the threshold as reached', () => {
    const plan = targetPlan(stats([[9, 1], [10, 1]]), 10, 12);
    expect(plan.reached).toBe(true);
    expect(roundedGrade(9.5)).toBe(10);
  });

  it('is not reached just below the threshold', () => {
    const plan = targetPlan(stats([[9, 1], [9, 1], [10, 1]]), 10, 12);
    expect(plan.reached).toBe(false);
    expect(plan.maxGradesNeeded).toBe(1);
  });

  it('is not reached when there are no grades at all', () => {
    const plan = targetPlan({ sum: 0, weightSum: 0 }, 10, 12);
    expect(plan.reached).toBe(false);
    expect(plan.impossible).toBe(false);
    expect(plan.maxGradesNeeded).toBe(1);
    expect(plan.options[0]).toEqual({ count: 1, neededAverage: 9.5 });
  });

  it('is impossible when the threshold lies above the scale', () => {
    for (const [scale, target] of [[12, 13], [5, 6], [100, 101]] as Array<[GradeScale, number]>) {
      const plan = targetPlan(stats([[scale, 1]]), target, scale);
      expect(plan.impossible).toBe(true);
      expect(plan.reached).toBe(false);
      expect(plan.maxGradesNeeded).toBeNull();
      expect(plan.options).toEqual([]);
    }
  });

  it('needs many top grades but is not impossible for target 12 with low grades', () => {
    const plan = targetPlan(stats([[1, 1], [1, 1], [1, 1]]), 12, 12);
    expect(plan.threshold).toBe(11.5);
    expect(plan.impossible).toBe(false);
    expect(plan.reached).toBe(false);
    expect(plan.maxGradesNeeded).toBe(63);
    expect(plan.options).toEqual([]);
  });

  it('computes the exact minimal number of maximum grades, checked by brute force', () => {
    const sets: Record<GradeScale, Array<Array<[number, number]>>> = {
      12: [[], [[8, 1], [9, 1]], [[5, 1], [5, 1], [6, 1]], [[10, 1], [11, 1], [12, 1]], [[4, 1]], [[7, 2], [9, 1]], [[1, 1], [2, 3]], [[6, 1], [7, 1], [8, 1], [5, 1], [9, 1], [6, 1]]],
      5: [[], [[3, 1], [4, 1]], [[2, 1], [2, 1], [3, 1]], [[4, 1], [5, 1]], [[1, 1]], [[3, 2], [4, 1]]],
      100: [[], [[60, 1], [70, 1]], [[85.5, 1], [90, 2]], [[40, 1], [55, 1], [61, 1]], [[99, 1]], [[20, 1], [30, 1], [25, 1], [10, 1]]],
    };
    let checked = 0;
    for (const scale of SCALES) {
      const targets = scale === 12 ? [1, 2, 3, 5, 7, 8, 10, 11, 12] : scale === 5 ? [1, 2, 3, 4, 5] : [1, 25, 50, 75, 90, 99, 100];
      for (const values of sets[scale]) {
        const s = stats(values);
        for (const target of targets) {
          const plan = targetPlan(s, target, scale);
          const current = s.weightSum ? s.sum / s.weightSum : 0;
          if (plan.reached) {
            expect(s.weightSum).toBeGreaterThan(0);
            expect(current).toBeGreaterThanOrEqual(plan.threshold - 1e-9);
            continue;
          }
          expect(plan.impossible).toBe(false);
          expect(plan.maxGradesNeeded).toBe(bruteMaxGrades(s, plan.threshold, scale));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it('lists options with the average needed from k new grades, verified by recomputing', () => {
    const cases: Array<[Array<[number, number]>, number, GradeScale]> = [
      [[[8, 1], [9, 1]], 10, 12],
      [[[5, 1], [6, 1], [7, 1]], 9, 12],
      [[[3, 1], [3, 1], [4, 1]], 5, 5],
      [[[70, 1], [75, 1]], 90, 100],
      [[[7, 2], [8, 1]], 11, 12],
      [[], 8, 12],
    ];
    for (const [values, target, scale] of cases) {
      const s = stats(values);
      const plan = targetPlan(s, target, scale, 12);
      expect(plan.reached).toBe(false);
      expect(plan.options.length).toBeGreaterThan(0);
      for (const opt of plan.options) {
        expect(opt.neededAverage).toBeLessThanOrEqual(scale + 1e-9);
        expect(opt.neededAverage).toBeGreaterThanOrEqual(minGrade(scale));
        const avg = (s.sum + opt.count * opt.neededAverage) / (s.weightSum + opt.count);
        expect(avg).toBeCloseTo(plan.threshold, 9);
        expect(roundedGrade(avg)).toBe(target);
      }
    }
  });

  it('lists exactly the counts reachable with maximum grades, in order', () => {
    const s = stats([[4, 1], [5, 1], [6, 1], [5, 1]]);
    const plan = targetPlan(s, 9, 12, 8);
    const expected: number[] = [];
    for (let k = 1; k <= 8; k++) if (k >= plan.maxGradesNeeded!) expected.push(k);
    expect(plan.options.map((o) => o.count)).toEqual(expected);
    expect(plan.options.length).toBeGreaterThan(0);
    expect(plan.options.length).toBeLessThan(8);
  });

  it('shows a smaller required average as more grades are allowed', () => {
    const plan = targetPlan(stats([[8, 1], [8, 1]]), 10, 12, 5);
    const needed = plan.options.map((o) => o.neededAverage);
    for (let i = 1; i < needed.length; i++) expect(needed[i]).toBeLessThan(needed[i - 1]);
  });

  it('honours maxCount', () => {
    expect(targetPlan(stats([[8, 1]]), 9, 12, 2).options.length).toBeLessThanOrEqual(2);
    expect(targetPlan(stats([[8, 1]]), 9, 12, 0).options).toEqual([]);
  });

  it('uses weight 1 for new grades while honouring the weights of existing ones', () => {
    const plan = targetPlan(stats([[6, 3]]), 9, 12);
    const needed = plan.options.find((o) => o.count === 3)!.neededAverage;
    expect((18 + 3 * needed) / 6).toBeCloseTo(8.5, 9);
  });

  it('works on the 5 point scale', () => {
    const s = stats([[3, 1], [4, 1], [3, 1]]);
    const plan = targetPlan(s, 4, 5);
    expect(plan.threshold).toBe(3.5);
    expect(plan.reached).toBe(false);
    expect(plan.maxGradesNeeded).toBe(bruteMaxGrades(s, 3.5, 5));
    expect(targetPlan(stats([[4, 1], [4, 1]]), 4, 5).reached).toBe(true);
  });

  it('works on the 100 point scale', () => {
    const s = stats([[70, 1], [80, 1]]);
    const plan = targetPlan(s, 90, 100);
    expect(plan.threshold).toBe(89.5);
    expect(plan.maxGradesNeeded).toBe(bruteMaxGrades(s, 89.5, 100));
    expect(targetPlan(stats([[95, 1]]), 90, 100).reached).toBe(true);
  });

  it('never lets the threshold fall below the minimum grade', () => {
    expect(targetPlan({ sum: 5, weightSum: 1 }, 1, 12).threshold).toBe(1);
    expect(targetPlan({ sum: 5, weightSum: 1 }, 0, 100).threshold).toBe(0);
  });
});

describe('parseGrades', () => {
  it('parses several grades after a subject', () => {
    const r = parseGrades('Математика 10 11 9', 12);
    expect(r.bad).toEqual([]);
    expect(r.grades).toEqual([
      { subject: 'Математика', value: 10, weight: 1 },
      { subject: 'Математика', value: 11, weight: 1 },
      { subject: 'Математика', value: 9, weight: 1 },
    ]);
  });

  it('parses a colon, commas and a weight multiplier', () => {
    const r = parseGrades('фізика: 8, 7x2', 12);
    expect(r.bad).toEqual([]);
    expect(r.grades).toEqual([
      { subject: 'Фізика', value: 8, weight: 1 },
      { subject: 'Фізика', value: 7, weight: 2 },
    ]);
  });

  it('parses a single grade', () => {
    expect(parseGrades('Англійська 12', 12)).toEqual({ grades: [{ subject: 'Англійська', value: 12, weight: 1 }], bad: [] });
  });

  it('rejects a grade above the scale', () => {
    const r = parseGrades('Історія 13', 12);
    expect(r.grades).toEqual([]);
    expect(r.bad).toEqual(['Історія 13']);
  });

  it('rejects a grade below the minimum, including 0 on the 12 and 5 scales', () => {
    expect(parseGrades('Історія 0', 12).bad).toEqual(['Історія 0']);
    expect(parseGrades('Історія 0', 5).bad).toEqual(['Історія 0']);
    expect(parseGrades('Історія 0', 100).grades).toEqual([{ subject: 'Історія', value: 0, weight: 1 }]);
  });

  it('rejects the whole line when one of its grades is out of range', () => {
    const r = parseGrades('Математика 10 13 9', 12);
    expect(r.grades).toEqual([]);
    expect(r.bad).toEqual(['Математика 10 13 9']);
  });

  it('applies the scale limits on the 5 and 100 point scales', () => {
    expect(parseGrades('Алгебра 5', 5).grades.length).toBe(1);
    expect(parseGrades('Алгебра 6', 5).bad).toEqual(['Алгебра 6']);
    expect(parseGrades('Фізика 100', 100).grades.length).toBe(1);
    expect(parseGrades('Фізика 101', 100).bad).toEqual(['Фізика 101']);
    expect(parseGrades('Фізика 87.5 90', 100).grades.map((g) => g.value)).toEqual([87.5, 90]);
  });

  it('reads a decimal grade with a dot as one grade', () => {
    expect(parseGrades('Алгебра 4.5', 5)).toEqual({ grades: [{ subject: 'Алгебра', value: 4.5, weight: 1 }], bad: [] });
  });

  it('parses multiple lines and separates good from bad ones', () => {
    const r = parseGrades('Математика 10 11\nФізика 8\nІсторія 14\nХімія 9', 12);
    expect(r.grades.map((g) => `${g.subject}:${g.value}`)).toEqual(['Математика:10', 'Математика:11', 'Фізика:8', 'Хімія:9']);
    expect(r.bad).toEqual(['Історія 14']);
  });

  it('treats semicolons as line separators', () => {
    const r = parseGrades('Математика 10; Фізика 8', 12);
    expect(r.bad).toEqual([]);
    expect(r.grades.map((g) => g.subject)).toEqual(['Математика', 'Фізика']);
  });

  it('skips blank lines and handles Windows line breaks', () => {
    const r = parseGrades('\n\nМатематика 10\r\n\r\n  \nФізика 8  \n', 12);
    expect(r.bad).toEqual([]);
    expect(r.grades.length).toBe(2);
  });

  it('returns nothing for empty text', () => {
    expect(parseGrades('', 12)).toEqual({ grades: [], bad: [] });
    expect(parseGrades('  \n ', 12)).toEqual({ grades: [], bad: [] });
  });

  it('rejects lines without a subject or without grades', () => {
    expect(parseGrades('10 11 9', 12).bad).toEqual(['10 11 9']);
    expect(parseGrades('Математика', 12).bad).toEqual(['Математика']);
    expect(parseGrades('Математика десять', 12).bad).toEqual(['Математика десять']);
    expect(parseGrades('Математика 10 балів', 12).bad).toEqual(['Математика 10 балів']);
  });

  it('accepts weights of every spelling of the multiplication sign', () => {
    for (const sign of ['x', 'X', 'х', 'Х', '×', '*', ' x ']) {
      const r = parseGrades(`Математика 7${sign}2`, 12);
      expect(r.bad).toEqual([]);
      expect(r.grades).toEqual([{ subject: 'Математика', value: 7, weight: 2 }]);
    }
  });

  it('enforces the weight limits above 0 and up to 10', () => {
    expect(parseGrades('Математика 7x10', 12).grades[0].weight).toBe(10);
    expect(parseGrades('Математика 7x0.5', 12).grades[0].weight).toBe(0.5);
    expect(parseGrades('Математика 7x0', 12).bad).toEqual(['Математика 7x0']);
    expect(parseGrades('Математика 7x11', 12).bad).toEqual(['Математика 7x11']);
    expect(parseGrades('Математика 7x10.5', 12).bad).toEqual(['Математика 7x10.5']);
  });

  it('capitalizes only the first letter of the subject and keeps the rest', () => {
    expect(parseGrades('українська мова 10', 12).grades[0].subject).toBe('Українська мова');
    expect(parseGrades('ІСТОРІЯ 10', 12).grades[0].subject).toBe('ІСТОРІЯ');
  });

  it('keeps digits that belong to the subject name', () => {
    const r = parseGrades('Алгебра 7 клас 10', 12);
    expect(r.bad).toEqual([]);
    expect(r.grades).toEqual([{ subject: 'Алгебра 7 клас', value: 10, weight: 1 }]);
  });

  it('accepts a dash separator and a trailing dot', () => {
    expect(parseGrades('Математика - 10.', 12).grades).toEqual([{ subject: 'Математика', value: 10, weight: 1 }]);
    expect(parseGrades('Математика: 10, 11,', 12).grades.map((g) => g.value)).toEqual([10, 11]);
  });

  it('feeds subjectStats so the same subject spelled differently merges', () => {
    const r = parseGrades('математика 10\nМатематика 8', 12);
    const stats = subjectStats(r.grades);
    expect(stats.length).toBe(1);
    expect(stats[0].average).toBe(9);
  });
});

describe('formatGrade', () => {
  it('uses a decimal comma and two digits by default', () => {
    expect(formatGrade(9.456)).toBe('9,46');
    expect(formatGrade(9.5)).toBe('9,5');
    expect(formatGrade(10)).toBe('10');
    expect(formatGrade(0)).toBe('0');
    expect(formatGrade(8.004)).toBe('8');
  });

  it('honours the number of digits', () => {
    expect(formatGrade(9.456, 1)).toBe('9,5');
    expect(formatGrade(9.456, 0)).toBe('9');
    expect(formatGrade(9.5, 0)).toBe('10');
    expect(formatGrade(9.4567, 3)).toBe('9,457');
  });

  it('formats 100 point scale values', () => {
    expect(formatGrade(87.5)).toBe('87,5');
    expect(formatGrade(100)).toBe('100');
  });
});

describe('buildStudyPlan: tight schedules', () => {
  it('finds the earliest-deadline-first schedule when it exists', () => {
    const subjects = [subject('А', 3, 3, inDays(2)), subject('Б', 3, 3, inDays(4)), subject('В', 3, 3, inDays(6))];
    const plan = buildStudyPlan(subjects, { budget: 720, availability: FLAT, from: FROM });
    expect(plan.subjects.map((s) => s.scheduled)).toEqual([240, 240, 240]);
    expect(plan.warnings).toEqual([]);
  });

  it('lets a subject exceed the daily cap only when it would not fit before its exam otherwise', () => {
    const wide = [300, 300, 300, 300, 300, 300, 300];
    const relaxed = buildStudyPlan([subject('А', 3, 3, inDays(2))], { budget: 600, availability: wide, from: FROM });
    expect(relaxed.subjects[0].scheduled).toBe(600);
    const spread = buildStudyPlan([subject('А', 3, 3, inDays(20))], { budget: 600, availability: wide, from: FROM });
    for (const d of spread.days) for (const s of d.sessions) expect(s.minutes).toBeLessThanOrEqual(120);
  });
});

describe('buildStudyPlan: catching up before an early exam', () => {
  it('uses a long Saturday when the weekday cap leaves the single subject short', () => {
    const subjects = [subject('А', 3, 3, ymd('2026-11-05'))];
    const opts: PlanOptions = { budget: 1230, availability: DEFAULT_AVAILABILITY, from: FROM };
    const plan = buildStudyPlan(subjects, opts);
    expectPlanInvariants(plan, subjects, opts);
    expect(plan.subjects[0].scheduled).toBe(1230);
    expect(plan.warnings).toEqual([]);
    expect(dayTotal(plan, '2026-10-31')).toBe(150);
  });

  it('gives the early exam its full share when other subjects share the same days', () => {
    const subjects = [subject('S0', 2, 3, inDays(14)), subject('S1', 3, 3, inDays(21)), subject('S2', 4, 3, inDays(30))];
    const opts: PlanOptions = { budget: 3300, availability: DEFAULT_AVAILABILITY, from: FROM };
    const plan = buildStudyPlan(subjects, opts);
    expectPlanInvariants(plan, subjects, opts);
    expect(plan.subjects[0].scheduled).toBe(plan.subjects[0].target);
    expect(plan.warnings.filter((w) => w.startsWith('S0'))).toEqual([]);
    expect(totalMinutes(plan)).toBe(3300);
  });

  it('counts only days with free time when deciding that a subject must catch up', () => {
    const weekends = [0, 0, 0, 0, 0, 240, 240];
    const subjects = [subject('А', 5, 1, inDays(4)), subject('Б', 1, 5, inDays(30))];
    const opts: PlanOptions = { budget: 360, availability: weekends, from: FROM };
    const plan = buildStudyPlan(subjects, opts);
    expectPlanInvariants(plan, subjects, opts);
    expect(plan.subjects[0].scheduled).toBe(240);
    expect(plan.subjects[1].scheduled).toBe(120);
    expect(plan.warnings).toEqual(['А: до іспиту вміщається лише 4 год, тож ще 2 год віддано іншим предметам.']);
  });
});

