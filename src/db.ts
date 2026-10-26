/**
 * Доступ до бази D1. Усі запити, що стосуються даних користувача, фільтрують
 * за user_id, тож чужий запис не можна змінити, навіть підробивши id у кнопці.
 *
 * Ліміти безкоштовного D1: 50 запитів на один виклик Worker-а (db.batch() рахується
 * як один запит) і 100 параметрів в одному запиті. Тому масові вставки йдуть
 * пакетами багаторядкових INSERT.
 */

/** Найбільше прив'язаних параметрів в одному запиті D1. */
const MAX_PARAMS = 100;
/** Найбільше занять у розкладі одного користувача. */
export const MAX_LESSONS = 100;

/**
 * Рядок таблиці users. Моменти часу в unix-секундах UTC, прапорці (`blocked`) 0 або 1.
 * `digest_min`: хвилини від локальної півночі, null вимикає ранкове зведення;
 * `lesson_lead`: за скільки хвилин нагадувати про заняття, 0 вимикає;
 * `availability`: JSON-масив хвилин навчання на день тижня, null означає типові;
 * `state` і `state_data`: на яку відповідь чекає бот і JSON з даними цього кроку;
 * `history` і `history_at`: JSON останніх реплік розмови з репетитором і момент запису;
 * `ai_day` і `ai_count`: день (UTC) і кількість запитів до ШІ за нього.
 */
export interface User {
  id: number;
  first_name: string | null;
  tz: string;
  digest_min: number | null;
  next_digest_at: number | null;
  lesson_lead: number;
  availability: string | null;
  grade_scale: number;
  timer_start: number | null;
  timer_subject: string | null;
  state: string | null;
  state_data: string | null;
  history: string | null;
  history_at: number | null;
  ai_day: string | null;
  ai_count: number;
  blocked: number;
  created_at: number;
}

/** Рядок таблиці lessons. `weekday`: 1 понеділок ... 7 неділя; `start_min` і `end_min`: хвилини від локальної півночі, `end_min` null, якщо кінець не вказано. */
export interface Lesson {
  id: number;
  user_id: number;
  weekday: number;
  start_min: number;
  end_min: number | null;
  title: string;
}

/** Рядок таблиці deadlines. `due_at`, `done_at`, `created_at`: unix-секунди UTC; `all_day` і `done`: 0 або 1; `importance` і `difficulty`: 1-3. */
export interface Deadline {
  id: number;
  user_id: number;
  title: string;
  due_at: number;
  all_day: number;
  importance: number;
  difficulty: number;
  done: number;
  done_at: number | null;
  created_at: number;
}

/** Рядок таблиці tasks. `kind`: 'split' (розбите завдання) або 'plan' (план підготовки); `deadline_id` null, якщо завдання не прив'язане до дедлайну. */
export interface Task {
  id: number;
  user_id: number;
  title: string;
  kind: 'split' | 'plan';
  deadline_id: number | null;
  created_at: number;
}

/** Завдання з прогресом: `total` кроків усього, `done_count` виконано. */
export interface TaskWithProgress extends Task {
  total: number;
  done_count: number;
}

/** Рядок таблиці steps. `pos`: порядок у завданні з 1; `minutes`: орієнтовна тривалість; `due_date`: 'YYYY-MM-DD' у поясі користувача; `done`: 0 або 1. */
export interface Step {
  id: number;
  task_id: number;
  user_id: number;
  pos: number;
  text: string;
  subject: string | null;
  minutes: number | null;
  due_date: string | null;
  done: number;
  done_at: number | null;
}

/** Крок для створення завдання; порядок кроків задається позицією в масиві. */
export interface NewStep {
  text: string;
  subject?: string | null;
  minutes?: number | null;
  due_date: string | null;
}

/** Сума хвилин навчання з одного предмета за день `day` ('YYYY-MM-DD' у поясі користувача). */
export interface StudyRow {
  day: string;
  subject: string;
  minutes: number;
}

/** Рядок таблиці grades. `weight`: вага оцінки, 1 для звичайної. */
export interface GradeRow {
  id: number;
  subject: string;
  value: number;
  weight: number;
  created_at: number;
}

/** Лічильники для оцінки прогресу, див. Db.progressCounts. */
export interface ProgressCounts {
  /** Кроки з датою в періоді: усього і виконано. */
  periodSteps: number;
  periodDone: number;
  /** Усі кроки всіх завдань. */
  allSteps: number;
  allDone: number;
  /** Дедлайни: виконані в періоді, виконані вчасно в періоді, прострочені відкриті. */
  deadlinesDone: number;
  deadlinesOnTime: number;
  overdueOpen: number;
}

/** Рядок таблиці quizzes. `questions`: JSON-масив питань; `current`: індекс питання, на яке чекаємо відповідь; `poll_id`: id опитування Telegram для поточного питання. */
export interface Quiz {
  id: number;
  user_id: number;
  topic: string | null;
  questions: string;
  current: number;
  score: number;
  poll_id: string | null;
  created_at: number;
}

/** Нагадування, час якого настав, разом з даними дедлайну і поясом власника. */
export interface DueReminder {
  id: number;
  user_id: number;
  deadline_id: number;
  remind_at: number;
  title: string;
  due_at: number;
  all_day: number;
  tz: string;
}

/** Обгортка над D1: методи з `userId` діють лише на записи цього користувача. Помилки D1 не перехоплюються. */
export class Db {
  constructor(readonly d1: D1Database) {}

  /** Багаторядкові INSERT-и, кожен не більше ніж на MAX_PARAMS параметрів. */
  private inserts(table: string, columns: string[], rows: unknown[][]): D1PreparedStatement[] {
    const perStatement = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
    const placeholders = `(${columns.map(() => '?').join(', ')})`;
    const out: D1PreparedStatement[] = [];
    for (let i = 0; i < rows.length; i += perStatement) {
      const chunk = rows.slice(i, i + perStatement);
      out.push(
        this.d1
          .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => placeholders).join(', ')}`)
          .bind(...chunk.flat()),
      );
    }
    return out;
  }

  /** Створює користувача при першому зверненні або оновлює ім'я; знімає позначку "заблокував бота". */
  async upsertUser(id: number, firstName: string | null, now: number, tz: string, nextDigestAt: number): Promise<User> {
    const row = await this.d1
      .prepare(
        `INSERT INTO users (id, first_name, tz, next_digest_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET first_name = excluded.first_name, blocked = 0
         RETURNING *`,
      )
      .bind(id, firstName, tz, nextDigestAt, now)
      .first<User>();
    if (!row) throw new Error('upsertUser returned no row');
    return row;
  }

  /** Користувач за id або null, якщо його ще немає. */
  getUser(id: number): Promise<User | null> {
    return this.d1.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
  }

  /** Запам'ятовує, на яку відповідь бот чекає (null скидає очікування). */
  async setState(userId: number, state: string | null, data: unknown = null): Promise<void> {
    await this.d1
      .prepare('UPDATE users SET state = ?, state_data = ? WHERE id = ?')
      .bind(state, data === null ? null : JSON.stringify(data), userId)
      .run();
  }

  /**
   * Атомарно скидає крок діалогу, якщо він досі такий, яким його бачив обробник
   * (`state` і `stateData` зі знімка користувача). Повертає false, якщо інший запит
   * уже встиг його забрати (наприклад, кнопку натиснули двічі поспіль).
   */
  async claimState(userId: number, state: string, stateData: string | null): Promise<boolean> {
    const r = await this.d1
      .prepare('UPDATE users SET state = NULL, state_data = NULL WHERE id = ? AND state = ? AND state_data IS ?')
      .bind(userId, state, stateData)
      .run();
    return r.meta.changes > 0;
  }

  /** Атомарно зупиняє таймер, запущений у момент `startedAt`; false, якщо його вже зупинено. */
  async claimTimer(userId: number, startedAt: number): Promise<boolean> {
    const r = await this.d1
      .prepare('UPDATE users SET timer_start = NULL, timer_subject = NULL WHERE id = ? AND timer_start = ?')
      .bind(userId, startedAt)
      .run();
    return r.meta.changes > 0;
  }

  /** Оновлює довільні поля користувача. Назви полів беруться лише з коду, не від користувача. */
  async updateUser(userId: number, fields: Partial<Omit<User, 'id'>>): Promise<void> {
    const keys = Object.keys(fields) as Array<keyof typeof fields>;
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    await this.d1
      .prepare(`UPDATE users SET ${sets} WHERE id = ?`)
      .bind(...keys.map((k) => fields[k] ?? null), userId)
      .run();
  }

  /** Ставить чи знімає позначку "заблокував бота". */
  async setBlocked(userId: number, blocked: boolean): Promise<void> {
    await this.d1.prepare('UPDATE users SET blocked = ? WHERE id = ?').bind(blocked ? 1 : 0, userId).run();
  }

  /**
   * Атомарно збільшує лічильник запитів до ШІ за день `day` і повертає нове значення.
   * Лічильник обнуляється, коли змінюється день.
   */
  async bumpAiCount(userId: number, day: string): Promise<number> {
    const row = await this.d1
      .prepare(
        `UPDATE users SET ai_count = CASE WHEN ai_day = ?1 THEN ai_count + 1 ELSE 1 END, ai_day = ?1
         WHERE id = ?2 RETURNING ai_count`,
      )
      .bind(day, userId)
      .first<{ ai_count: number }>();
    return row?.ai_count ?? 1;
  }

  /** Повертає один запит до ШІ, якщо його не вдалося виконати. */
  async refundAiCount(userId: number, day: string): Promise<void> {
    await this.d1
      .prepare('UPDATE users SET ai_count = MAX(ai_count - 1, 0) WHERE id = ? AND ai_day = ?')
      .bind(userId, day)
      .run();
  }

  /**
   * Видаляє всі дані користувача. Сам рядок users лишається лише з id і денним
   * лічильником запитів до ШІ, щоб видалення даних не обнуляло ліміт.
   */
  async deleteUser(userId: number, defaultTz: string): Promise<void> {
    await this.d1.batch([
      this.d1.prepare('DELETE FROM reminders WHERE user_id = ?').bind(userId),
      this.d1.prepare('DELETE FROM steps WHERE user_id = ?').bind(userId),
      this.d1.prepare('DELETE FROM tasks WHERE user_id = ?').bind(userId),
      this.d1.prepare('DELETE FROM deadlines WHERE user_id = ?').bind(userId),
      this.d1.prepare('DELETE FROM lessons WHERE user_id = ?').bind(userId),
      this.d1.prepare('DELETE FROM quizzes WHERE user_id = ?').bind(userId),
      this.d1.prepare('DELETE FROM study_log WHERE user_id = ?').bind(userId),
      this.d1.prepare('DELETE FROM grades WHERE user_id = ?').bind(userId),
      this.d1
        .prepare(
          `UPDATE users SET first_name = NULL, tz = ?, digest_min = NULL, next_digest_at = NULL, lesson_lead = 0,
             availability = NULL, grade_scale = 12, timer_start = NULL, timer_subject = NULL, state = NULL,
             state_data = NULL, history = NULL, history_at = NULL WHERE id = ?`,
        )
        .bind(defaultTz, userId),
    ]);
  }

  /**
   * Додає заняття, пропускаючи ті, що вже є (той самий день, час і назва), і не
   * перевищуючи MAX_LESSONS на користувача. Повертає, скільки занять додано.
   */
  async addLessons(userId: number, lessons: Array<{ weekday: number; start: number; end: number | null; title: string }>): Promise<number> {
    if (!lessons.length) return 0;
    const existing = await this.listLessons(userId);
    const seen = new Set(existing.map((l) => `${l.weekday}|${l.start_min}|${l.title.toLowerCase()}`));
    const fresh: typeof lessons = [];
    for (const l of lessons) {
      const key = `${l.weekday}|${l.start}|${l.title.toLowerCase()}`;
      if (seen.has(key) || existing.length + fresh.length >= MAX_LESSONS) continue;
      seen.add(key);
      fresh.push(l);
    }
    if (!fresh.length) return 0;
    await this.d1.batch(
      this.inserts(
        'lessons',
        ['user_id', 'weekday', 'start_min', 'end_min', 'title'],
        fresh.map((l) => [userId, l.weekday, l.start, l.end, l.title]),
      ),
    );
    return fresh.length;
  }

  /** Заняття користувача (лише за день тижня `weekday`, якщо його задано), за часом початку. */
  async listLessons(userId: number, weekday?: number): Promise<Lesson[]> {
    const stmt =
      weekday === undefined
        ? this.d1.prepare('SELECT * FROM lessons WHERE user_id = ? ORDER BY weekday, start_min').bind(userId)
        : this.d1.prepare('SELECT * FROM lessons WHERE user_id = ? AND weekday = ? ORDER BY start_min').bind(userId, weekday);
    return (await stmt.all<Lesson>()).results;
  }

  /** Кількість занять користувача. */
  async countLessons(userId: number): Promise<number> {
    const row = await this.d1.prepare('SELECT COUNT(*) AS n FROM lessons WHERE user_id = ?').bind(userId).first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Видаляє заняття користувача. false, якщо такого немає. */
  async deleteLesson(userId: number, id: number): Promise<boolean> {
    const r = await this.d1.prepare('DELETE FROM lessons WHERE id = ? AND user_id = ?').bind(id, userId).run();
    return r.meta.changes > 0;
  }

  /** Видаляє весь розклад користувача. */
  async clearLessons(userId: number): Promise<void> {
    await this.d1.prepare('DELETE FROM lessons WHERE user_id = ?').bind(userId).run();
  }

  /** Створює дедлайн разом із нагадуваннями (`reminders`: моменти в unix-секундах). */
  async addDeadline(userId: number, title: string, due: number, allDay: boolean, reminders: number[], now: number): Promise<number> {
    const row = await this.d1
      .prepare('INSERT INTO deadlines (user_id, title, due_at, all_day, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .bind(userId, title, due, allDay ? 1 : 0, now)
      .first<{ id: number }>();
    if (!row) throw new Error('addDeadline returned no id');
    if (reminders.length) {
      await this.d1.batch(this.inserts('reminders', ['user_id', 'deadline_id', 'remind_at'], reminders.map((at) => [userId, row.id, at])));
    }
    return row.id;
  }

  /** Задає важливість чи складність дедлайну (1-3). */
  async setDeadlineRating(userId: number, id: number, field: 'importance' | 'difficulty', value: number): Promise<boolean> {
    const r = await this.d1
      .prepare(`UPDATE deadlines SET ${field === 'importance' ? 'importance' : 'difficulty'} = ? WHERE id = ? AND user_id = ?`)
      .bind(Math.min(3, Math.max(1, value)), id, userId)
      .run();
    return r.meta.changes > 0;
  }

  /** Дедлайн користувача за id або null. */
  getDeadline(userId: number, id: number): Promise<Deadline | null> {
    return this.d1.prepare('SELECT * FROM deadlines WHERE id = ? AND user_id = ?').bind(id, userId).first<Deadline>();
  }

  /** Невиконані дедлайни: спершу прострочені й найближчі. */
  async listOpenDeadlines(userId: number, limit = 20): Promise<Deadline[]> {
    return (
      await this.d1
        .prepare('SELECT * FROM deadlines WHERE user_id = ? AND done = 0 ORDER BY due_at LIMIT ?')
        .bind(userId, limit)
        .all<Deadline>()
    ).results;
  }

  /** Кількість невиконаних дедлайнів користувача. */
  async countOpenDeadlines(userId: number): Promise<number> {
    const row = await this.d1
      .prepare('SELECT COUNT(*) AS n FROM deadlines WHERE user_id = ? AND done = 0')
      .bind(userId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Позначає дедлайн виконаним і гасить його ненадіслані нагадування. false, якщо вже виконаний. */
  async setDeadlineDone(userId: number, id: number, now: number): Promise<boolean> {
    const [r] = await this.d1.batch([
      this.d1.prepare('UPDATE deadlines SET done = 1, done_at = ? WHERE id = ? AND user_id = ? AND done = 0').bind(now, id, userId),
      this.d1.prepare('UPDATE reminders SET sent = 1 WHERE deadline_id = ? AND user_id = ? AND sent = 0').bind(id, userId),
    ]);
    return r.meta.changes > 0;
  }

  /** Відкритий дедлайн із такою самою назвою й моментом (щоб не дублювати дати іспитів). */
  findOpenDeadline(userId: number, title: string, due: number): Promise<Deadline | null> {
    return this.d1
      .prepare('SELECT * FROM deadlines WHERE user_id = ? AND done = 0 AND title = ? AND due_at = ?')
      .bind(userId, title, due)
      .first<Deadline>();
  }

  /** Видаляє дедлайн разом з нагадуваннями; пов'язані завдання лишаються, але втрачають зв'язок з ним. false, якщо дедлайну немає. */
  async deleteDeadline(userId: number, id: number): Promise<boolean> {
    const results = await this.d1.batch([
      this.d1.prepare('DELETE FROM reminders WHERE deadline_id = ? AND user_id = ?').bind(id, userId),
      this.d1.prepare('UPDATE tasks SET deadline_id = NULL WHERE deadline_id = ? AND user_id = ?').bind(id, userId),
      this.d1.prepare('DELETE FROM deadlines WHERE id = ? AND user_id = ?').bind(id, userId),
    ]);
    return (results[2]?.meta.changes ?? 0) > 0;
  }

  /** Нагадування, час яких настав, для активних дедлайнів користувачів, що не заблокували бота. */
  async dueReminders(now: number, limit: number): Promise<DueReminder[]> {
    return (
      await this.d1
        .prepare(
          `SELECT r.id, r.user_id, r.deadline_id, r.remind_at, d.title, d.due_at, d.all_day, u.tz
           FROM reminders r
           JOIN deadlines d ON d.id = r.deadline_id
           JOIN users u ON u.id = r.user_id
           WHERE r.sent = 0 AND r.remind_at <= ? AND d.done = 0 AND u.blocked = 0
           ORDER BY r.remind_at LIMIT ?`,
        )
        .bind(now, limit)
        .all<DueReminder>()
    ).results;
  }

  /** Позначає нагадування надісланими, щоб вони не повторювалися. */
  async markRemindersSent(ids: number[]): Promise<void> {
    if (!ids.length) return;
    await this.d1.batch(ids.map((id) => this.d1.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').bind(id)));
  }

  /** Створює завдання з кроками і повертає його id. */
  async createTask(
    userId: number,
    title: string,
    kind: 'split' | 'plan',
    deadlineId: number | null,
    steps: NewStep[],
    now: number,
  ): Promise<number> {
    const row = await this.d1
      .prepare('INSERT INTO tasks (user_id, title, kind, deadline_id, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .bind(userId, title, kind, deadlineId, now)
      .first<{ id: number }>();
    if (!row) throw new Error('createTask returned no id');
    if (steps.length) {
      await this.d1.batch(
        this.inserts(
          'steps',
          ['task_id', 'user_id', 'pos', 'text', 'subject', 'minutes', 'due_date'],
          steps.map((s, i) => [row.id, userId, i + 1, s.text, s.subject ?? null, s.minutes ?? null, s.due_date]),
        ),
      );
    }
    return row.id;
  }

  /** id завдань-планів користувача з такою назвою (для заміни плану новим). */
  async planTaskIds(userId: number, title: string): Promise<number[]> {
    const rows = (
      await this.d1.prepare("SELECT id FROM tasks WHERE user_id = ? AND kind = 'plan' AND title = ?").bind(userId, title).all<{ id: number }>()
    ).results;
    return rows.map((r) => r.id);
  }

  /** Перше розбите завдання, прив'язане до дедлайну (щоб не розбивати двічі). */
  async splitTaskForDeadline(userId: number, deadlineId: number): Promise<number | null> {
    const row = await this.d1
      .prepare("SELECT id FROM tasks WHERE user_id = ? AND deadline_id = ? AND kind = 'split' ORDER BY id LIMIT 1")
      .bind(userId, deadlineId)
      .first<{ id: number }>();
    return row?.id ?? null;
  }

  /** Завдання користувача з прогресом, від найновіших. */
  async listTasks(userId: number, limit = 15): Promise<TaskWithProgress[]> {
    return (
      await this.d1
        .prepare(
          `SELECT t.*, COUNT(s.id) AS total, COALESCE(SUM(s.done), 0) AS done_count
           FROM tasks t LEFT JOIN steps s ON s.task_id = t.id
           WHERE t.user_id = ? GROUP BY t.id ORDER BY t.created_at DESC LIMIT ?`,
        )
        .bind(userId, limit)
        .all<TaskWithProgress>()
    ).results;
  }

  /** Завдання з кроками за порядком або null, якщо його немає в цього користувача. */
  async getTask(userId: number, taskId: number): Promise<{ task: Task; steps: Step[] } | null> {
    const [taskRes, stepsRes] = await this.d1.batch([
      this.d1.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').bind(taskId, userId),
      this.d1.prepare('SELECT * FROM steps WHERE task_id = ? AND user_id = ? ORDER BY pos').bind(taskId, userId),
    ]);
    const task = (taskRes.results as Task[])[0];
    if (!task) return null;
    return { task, steps: stepsRes.results as Step[] };
  }

  /**
   * Перемикає позначку "виконано" для кроку. Для виконаного кроку з тривалістю
   * записує витрачений час у study_log (предмет кроку або назва завдання), а при
   * знятті позначки цей запис видаляє. Повертає id завдання або null, якщо кроку немає.
   */
  async toggleStep(userId: number, stepId: number, now: number, day: string): Promise<number | null> {
    // Один пакет виконується як транзакція: запис часу завжди відповідає стану кроку,
    // навіть якщо два натискання прийшли одночасно.
    const [toggled] = await this.d1.batch([
      this.d1
        .prepare('UPDATE steps SET done = 1 - done, done_at = CASE WHEN done = 0 THEN ? ELSE NULL END WHERE id = ? AND user_id = ? RETURNING task_id')
        .bind(now, stepId, userId),
      this.d1
        .prepare('DELETE FROM study_log WHERE step_id = ?1 AND user_id = ?2 AND NOT EXISTS (SELECT 1 FROM steps WHERE id = ?1 AND done = 1)')
        .bind(stepId, userId),
      this.d1
        .prepare(
          `INSERT INTO study_log (user_id, subject, minutes, day, step_id, created_at)
           SELECT s.user_id, COALESCE(s.subject, t.title), s.minutes, ?3, s.id, ?4 FROM steps s JOIN tasks t ON t.id = s.task_id
           WHERE s.id = ?1 AND s.user_id = ?2 AND s.done = 1 AND s.minutes IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM study_log WHERE step_id = ?1)`,
        )
        .bind(stepId, userId, day, now),
    ]);
    return (toggled.results[0] as { task_id: number } | undefined)?.task_id ?? null;
  }

  /** Сума хвилин невиконаних кроків за датами від `fromYmd`: скільки часу вже заплановано. */
  async busyByDate(userId: number, fromYmd: string, excludeTaskIds: number[] = []): Promise<Record<string, number>> {
    const exclude = excludeTaskIds.length ? `AND task_id NOT IN (${excludeTaskIds.map(() => '?').join(', ')})` : '';
    const rows = (
      await this.d1
        .prepare(
          `SELECT due_date, SUM(minutes) AS m FROM steps
           WHERE user_id = ? AND done = 0 AND due_date >= ? AND minutes IS NOT NULL ${exclude} GROUP BY due_date`,
        )
        .bind(userId, fromYmd, ...excludeTaskIds.slice(0, 50))
        .all<{ due_date: string; m: number }>()
    ).results;
    return Object.fromEntries(rows.map((r) => [r.due_date, r.m]));
  }

  /** Видаляє завдання разом з кроками. Записи часу навчання лишаються, але відв'язуються від кроків. false, якщо завдання немає. */
  async deleteTask(userId: number, taskId: number): Promise<boolean> {
    const results = await this.d1.batch([
      this.d1.prepare('UPDATE study_log SET step_id = NULL WHERE step_id IN (SELECT id FROM steps WHERE task_id = ? AND user_id = ?)').bind(taskId, userId),
      this.d1.prepare('DELETE FROM steps WHERE task_id = ? AND user_id = ?').bind(taskId, userId),
      this.d1.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').bind(taskId, userId),
    ]);
    return (results[2]?.meta.changes ?? 0) > 0;
  }

  /**
   * Дані для ранкового зведення одним пакетом: заняття на день тижня, найближчі
   * дедлайни до моменту `until` (і до 3 прострочених), кроки на сьогодні (і до 3
   * прострочених). Прострочене не витісняє сьогоднішнє.
   */
  async digestData(
    userId: number,
    weekday: number,
    now: number,
    until: number,
    todayYmd: string,
  ): Promise<{ lessons: Lesson[]; deadlines: Deadline[]; steps: Array<Step & { task_title: string }> }> {
    const stepSql = `SELECT s.*, t.title AS task_title FROM steps s JOIN tasks t ON t.id = s.task_id
       WHERE s.user_id = ? AND s.done = 0 AND s.due_date`;
    const [l, overdue, upcoming, lateSteps, todaySteps] = await this.d1.batch([
      this.d1.prepare('SELECT * FROM lessons WHERE user_id = ? AND weekday = ? ORDER BY start_min').bind(userId, weekday),
      this.d1.prepare('SELECT * FROM deadlines WHERE user_id = ? AND done = 0 AND due_at < ? ORDER BY due_at DESC LIMIT 3').bind(userId, now),
      this.d1
        .prepare('SELECT * FROM deadlines WHERE user_id = ? AND done = 0 AND due_at >= ? AND due_at <= ? ORDER BY due_at LIMIT 8')
        .bind(userId, now, until),
      this.d1.prepare(`${stepSql} < ? ORDER BY s.due_date DESC, s.pos LIMIT 3`).bind(userId, todayYmd),
      this.d1.prepare(`${stepSql} = ? ORDER BY s.pos LIMIT 8`).bind(userId, todayYmd),
    ]);
    return {
      lessons: l.results as Lesson[],
      deadlines: [...(overdue.results as Deadline[]).reverse(), ...(upcoming.results as Deadline[])],
      steps: [...(todaySteps.results as Array<Step & { task_title: string }>), ...(lateSteps.results as Array<Step & { task_title: string }>)],
    };
  }

  /** Користувачі, чий час ранкового зведення настав (не більше `limit`), від тих, кого чекали найдовше. */
  async usersForDigest(now: number, limit: number): Promise<User[]> {
    return (
      await this.d1
        .prepare(
          `SELECT * FROM users WHERE digest_min IS NOT NULL AND blocked = 0 AND next_digest_at <= ?
           ORDER BY next_digest_at LIMIT ?`,
        )
        .bind(now, limit)
        .all<User>()
    ).results;
  }

  /** Записує момент наступного ранкового зведення кільком користувачам одним пакетом. */
  async setNextDigests(updates: Array<{ id: number; next: number }>): Promise<void> {
    if (!updates.length) return;
    await this.d1.batch(updates.map((u) => this.d1.prepare('UPDATE users SET next_digest_at = ? WHERE id = ?').bind(u.next, u.id)));
  }

  /** Пари (пояс, випередження) серед тих, хто ввімкнув нагадування про заняття. */
  async lessonReminderGroups(): Promise<Array<{ tz: string; lesson_lead: number }>> {
    return (
      await this.d1
        .prepare('SELECT DISTINCT tz, lesson_lead FROM users WHERE lesson_lead > 0 AND blocked = 0 ORDER BY tz, lesson_lead')
        .all<{ tz: string; lesson_lead: number }>()
    ).results;
  }

  /**
   * Заняття, що починаються в задані моменти, для кількох груп (пояс, випередження)
   * одним пакетом: один запит до D1 незалежно від кількості груп.
   */
  async lessonsStartingAt(
    groups: Array<{ tz: string; lead: number; slots: Array<{ weekday: number; minute: number }> }>,
  ): Promise<Array<Lesson & { lead: number }>> {
    const statements = groups
      .filter((g) => g.slots.length)
      .map((g) => {
        const cond = g.slots.map(() => '(l.weekday = ? AND l.start_min = ?)').join(' OR ');
        return this.d1
          .prepare(
            `SELECT l.*, u.lesson_lead AS lead FROM lessons l JOIN users u ON u.id = l.user_id
             WHERE u.tz = ? AND u.lesson_lead = ? AND u.blocked = 0 AND (${cond}) LIMIT 40`,
          )
          .bind(g.tz, g.lead, ...g.slots.flatMap((s) => [s.weekday, s.minute]));
      });
    if (!statements.length) return [];
    const results = await this.d1.batch(statements);
    return results.flatMap((r) => r.results as Array<Lesson & { lead: number }>);
  }

  /** Зберігає тест (`questions` серіалізується в JSON) і повертає його id. */
  async createQuiz(userId: number, topic: string, questions: unknown, now: number): Promise<number> {
    const row = await this.d1
      .prepare('INSERT INTO quizzes (user_id, topic, questions, created_at) VALUES (?, ?, ?, ?) RETURNING id')
      .bind(userId, topic, JSON.stringify(questions), now)
      .first<{ id: number }>();
    if (!row) throw new Error('createQuiz returned no id');
    return row.id;
  }

  /** Тест за id опитування Telegram або null. */
  getQuizByPoll(pollId: string): Promise<Quiz | null> {
    return this.d1.prepare('SELECT * FROM quizzes WHERE poll_id = ?').bind(pollId).first<Quiz>();
  }

  /** Оновлює прогрес тесту. Назви полів беруться лише з коду. */
  async updateQuiz(id: number, fields: { current?: number; score?: number; poll_id?: string | null }): Promise<void> {
    const keys = Object.keys(fields) as Array<keyof typeof fields>;
    if (!keys.length) return;
    await this.d1
      .prepare(`UPDATE quizzes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .bind(...keys.map((k) => fields[k] ?? null), id)
      .run();
  }

  /** Записує `minutes` хвилин навчання з предмета за день `day` ('YYYY-MM-DD'). */
  async addStudy(userId: number, subject: string, minutes: number, day: string, now: number): Promise<void> {
    await this.d1
      .prepare('INSERT INTO study_log (user_id, subject, minutes, day, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(userId, subject, minutes, day, now)
      .run();
  }

  /** Записи часу навчання від дати `fromYmd` включно, згруповані за днем і предметом. */
  async studyByDay(userId: number, fromYmd: string): Promise<StudyRow[]> {
    return (
      await this.d1
        .prepare(
          `SELECT day, subject, SUM(minutes) AS minutes FROM study_log
           WHERE user_id = ? AND day >= ? GROUP BY day, subject ORDER BY day`,
        )
        .bind(userId, fromYmd)
        .all<StudyRow>()
    ).results;
  }

  /** Предмети, з яких людина вчилася чи планувала вчитися останнім часом. */
  async recentSubjects(userId: number, limit = 8): Promise<string[]> {
    const rows = (
      await this.d1
        .prepare(
          `SELECT subject FROM (
             SELECT subject, MAX(created_at) AS t FROM study_log WHERE user_id = ?1 GROUP BY subject
             UNION ALL
             SELECT subject, 0 AS t FROM steps WHERE user_id = ?1 AND subject IS NOT NULL GROUP BY subject
           ) GROUP BY subject ORDER BY MAX(t) DESC LIMIT ?2`,
        )
        .bind(userId, limit)
        .all<{ subject: string }>()
    ).results;
    return rows.map((r) => r.subject);
  }

  /** Зберігає оцінки одним пакетом; порожній масив нічого не робить. */
  async addGrades(userId: number, grades: Array<{ subject: string; value: number; weight: number }>, now: number): Promise<void> {
    if (!grades.length) return;
    await this.d1.batch(
      this.inserts(
        'grades',
        ['user_id', 'subject', 'value', 'weight', 'created_at'],
        grades.map((g) => [userId, g.subject, g.value, g.weight, now]),
      ),
    );
  }

  /** Усі оцінки користувача в порядку додавання. */
  async listGrades(userId: number): Promise<GradeRow[]> {
    return (
      await this.d1.prepare('SELECT id, subject, value, weight, created_at FROM grades WHERE user_id = ? ORDER BY id').bind(userId).all<GradeRow>()
    ).results;
  }

  /** Видаляє останню додану оцінку і повертає її (або null, якщо оцінок немає). */
  async deleteLastGrade(userId: number): Promise<GradeRow | null> {
    return this.d1
      .prepare('DELETE FROM grades WHERE id = (SELECT MAX(id) FROM grades WHERE user_id = ?1) AND user_id = ?1 RETURNING id, subject, value, weight, created_at')
      .bind(userId)
      .first<GradeRow>();
  }

  /** Видаляє всі оцінки користувача. */
  async clearGrades(userId: number): Promise<void> {
    await this.d1.prepare('DELETE FROM grades WHERE user_id = ?').bind(userId).run();
  }

  /** Лічильники для оцінки прогресу за період [fromYmd, toYmd] (дати кроків) і [fromTs, toTs] (виконання дедлайнів). */
  async progressCounts(userId: number, fromYmd: string, toYmd: string, fromTs: number, toTs: number, now: number): Promise<ProgressCounts> {
    const [period, all, dl, overdue] = await this.d1.batch([
      this.d1
        .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM steps WHERE user_id = ? AND due_date BETWEEN ? AND ?')
        .bind(userId, fromYmd, toYmd),
      this.d1.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM steps WHERE user_id = ?').bind(userId),
      this.d1
        .prepare(
          `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN done_at <= due_at THEN 1 ELSE 0 END), 0) AS done
           FROM deadlines WHERE user_id = ? AND done = 1 AND done_at BETWEEN ? AND ?`,
        )
        .bind(userId, fromTs, toTs),
      this.d1.prepare('SELECT COUNT(*) AS total, 0 AS done FROM deadlines WHERE user_id = ? AND done = 0 AND due_at < ?').bind(userId, now),
    ]);
    const row = (r: D1Result) => (r.results[0] as { total: number; done: number } | undefined) ?? { total: 0, done: 0 };
    return {
      periodSteps: row(period).total,
      periodDone: row(period).done,
      allSteps: row(all).total,
      allDone: row(all).done,
      deadlinesDone: row(dl).total,
      deadlinesOnTime: row(dl).done,
      overdueOpen: row(overdue).total,
    };
  }

  /** Моменти виконання кроків і дедлайнів від `fromTs`: для графіка виконаних завдань. */
  async completionTimes(userId: number, fromTs: number): Promise<number[]> {
    const [steps, deadlines] = await this.d1.batch([
      this.d1.prepare('SELECT done_at AS t FROM steps WHERE user_id = ? AND done = 1 AND done_at >= ?').bind(userId, fromTs),
      this.d1.prepare('SELECT done_at AS t FROM deadlines WHERE user_id = ? AND done = 1 AND done_at >= ?').bind(userId, fromTs),
    ]);
    return [...(steps.results as Array<{ t: number }>), ...(deadlines.results as Array<{ t: number }>)].map((r) => r.t);
  }

  /** Значення службового ключа з таблиці meta або null. */
  async getMeta(key: string): Promise<string | null> {
    const row = await this.d1.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  /** Записує службовий ключ, перезаписуючи наявне значення. */
  async setMeta(key: string, value: string): Promise<void> {
    await this.d1
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .bind(key, value)
      .run();
  }

  /** Прибирає відпрацьоване: надіслані нагадування, старі тести, давно виконані дедлайни. */
  async cleanup(now: number): Promise<void> {
    const old = now - 60 * 86400;
    await this.d1.batch([
      this.d1.prepare('DELETE FROM reminders WHERE sent = 1 AND remind_at < ?').bind(now - 7 * 86400),
      this.d1.prepare('DELETE FROM reminders WHERE remind_at < ? AND user_id IN (SELECT id FROM users WHERE blocked = 1)').bind(now - 86400),
      this.d1.prepare('DELETE FROM quizzes WHERE created_at < ?').bind(now - 3 * 86400),
      this.d1.prepare('DELETE FROM reminders WHERE deadline_id IN (SELECT id FROM deadlines WHERE done = 1 AND done_at < ?)').bind(old),
      this.d1.prepare('UPDATE tasks SET deadline_id = NULL WHERE deadline_id IN (SELECT id FROM deadlines WHERE done = 1 AND done_at < ?)').bind(old),
      this.d1.prepare('DELETE FROM deadlines WHERE done = 1 AND done_at < ?').bind(old),
    ]);
  }

  /** Статистика для адміністратора: усього й активних (не заблокували бота) користувачів, відкриті дедлайни та запити до ШІ за день `day`. */
  async stats(day: string): Promise<{ users: number; active: number; deadlines: number; aiToday: number }> {
    const [u, a, d, ai] = await this.d1.batch([
      this.d1.prepare('SELECT COUNT(*) AS n FROM users'),
      this.d1.prepare('SELECT COUNT(*) AS n FROM users WHERE blocked = 0'),
      this.d1.prepare('SELECT COUNT(*) AS n FROM deadlines WHERE done = 0'),
      this.d1.prepare('SELECT COALESCE(SUM(ai_count), 0) AS n FROM users WHERE ai_day = ?').bind(day),
    ]);
    const n = (r: D1Result) => (r.results[0] as { n: number } | undefined)?.n ?? 0;
    return { users: n(u), active: n(a), deadlines: n(d), aiToday: n(ai) };
  }
}
