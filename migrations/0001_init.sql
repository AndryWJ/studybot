-- Початкова схема бази StudyBot (Cloudflare D1, діалект SQLite).
-- Моменти часу: unix-секунди UTC. Дати кроків: 'YYYY-MM-DD' у поясі користувача.

CREATE TABLE users (
  id             INTEGER PRIMARY KEY,           -- Telegram user id, він же id приватного чату
  first_name     TEXT,
  tz             TEXT    NOT NULL DEFAULT 'Europe/Kyiv',
  digest_min     INTEGER DEFAULT 450,           -- час ранкового зведення, хвилини від півночі; NULL вимикає
  next_digest_at INTEGER,
  lesson_lead    INTEGER NOT NULL DEFAULT 0,    -- за скільки хвилин нагадувати про заняття; 0 вимикає
  availability   TEXT,                          -- JSON [пн..нд]: хвилин на навчання в кожен день тижня; NULL означає типові
  grade_scale    INTEGER NOT NULL DEFAULT 12,   -- шкала оцінок: 12, 5 або 100
  timer_start    INTEGER,                       -- момент запуску таймера навчання; NULL, якщо таймер не йде
  timer_subject  TEXT,
  state          TEXT,                          -- на яку відповідь бот чекає від користувача
  state_data     TEXT,                          -- JSON із даними цього кроку
  history        TEXT,                          -- JSON: останні репліки розмови з ШІ-репетитором
  history_at     INTEGER,
  ai_day         TEXT,                          -- дата (UTC), за яку рахується ai_count
  ai_count       INTEGER NOT NULL DEFAULT 0,
  blocked        INTEGER NOT NULL DEFAULT 0,    -- 1, якщо користувач заблокував бота
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_users_digest ON users (next_digest_at) WHERE digest_min IS NOT NULL AND blocked = 0;
CREATE INDEX idx_users_lessons ON users (tz, lesson_lead) WHERE lesson_lead > 0 AND blocked = 0;

CREATE TABLE lessons (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  weekday   INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),  -- 1 понеділок ... 7 неділя
  start_min INTEGER NOT NULL,
  end_min   INTEGER,
  title     TEXT    NOT NULL
);
CREATE INDEX idx_lessons_user ON lessons (user_id, weekday, start_min);
CREATE INDEX idx_lessons_time ON lessons (weekday, start_min);

CREATE TABLE deadlines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title      TEXT    NOT NULL,
  due_at     INTEGER NOT NULL,
  all_day    INTEGER NOT NULL DEFAULT 0,
  importance INTEGER NOT NULL DEFAULT 2,         -- 1 низька, 2 середня, 3 висока
  difficulty INTEGER NOT NULL DEFAULT 2,         -- 1 легко, 2 середньо, 3 важко
  done       INTEGER NOT NULL DEFAULT 0,
  done_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_deadlines_user ON deadlines (user_id, done, due_at);

CREATE TABLE reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  deadline_id INTEGER NOT NULL REFERENCES deadlines (id) ON DELETE CASCADE,
  remind_at   INTEGER NOT NULL,
  sent        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_reminders_due ON reminders (sent, remind_at);
CREATE INDEX idx_reminders_deadline ON reminders (deadline_id);

CREATE TABLE tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'split',  -- 'split' розбите завдання, 'plan' план підготовки
  deadline_id INTEGER REFERENCES deadlines (id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_tasks_user ON tasks (user_id, created_at);

CREATE TABLE steps (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL,
  pos      INTEGER NOT NULL,
  text     TEXT    NOT NULL,
  subject  TEXT,                                 -- предмет заняття з плану підготовки
  minutes  INTEGER,                              -- скільки хвилин займає крок
  due_date TEXT,
  done     INTEGER NOT NULL DEFAULT 0,
  done_at  INTEGER
);
CREATE INDEX idx_steps_task ON steps (task_id, pos);
CREATE INDEX idx_steps_user_due ON steps (user_id, done, due_date);

CREATE TABLE quizzes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  topic      TEXT,
  questions  TEXT    NOT NULL,                  -- JSON-масив питань
  current    INTEGER NOT NULL DEFAULT 0,        -- індекс питання, на яке чекаємо відповідь
  score      INTEGER NOT NULL DEFAULT 0,
  poll_id    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_quizzes_poll ON quizzes (poll_id);

CREATE TABLE study_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  subject    TEXT    NOT NULL,
  minutes    INTEGER NOT NULL,
  day        TEXT    NOT NULL,                  -- 'YYYY-MM-DD' у поясі користувача
  step_id    INTEGER,                           -- крок плану, виконання якого записало цей час
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_study_log_user ON study_log (user_id, day);
CREATE INDEX idx_study_log_step ON study_log (step_id);

CREATE TABLE grades (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  subject    TEXT    NOT NULL,
  value      REAL    NOT NULL,
  weight     REAL    NOT NULL DEFAULT 1,        -- вага оцінки, наприклад 2 для контрольної
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_grades_user ON grades (user_id, subject);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
