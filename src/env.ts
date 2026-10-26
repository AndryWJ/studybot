/**
 * Опис оточення Worker-а: прив'язки Cloudflare, змінні з wrangler.jsonc і секрети.
 *
 * Змінні з "vars" видно всім, хто має доступ до коду, тому токени й ключі API
 * задаються лише як секрети (`npx wrangler secret put`) і тут позначені як такі.
 */

/** Прив'язки й змінні Worker-а. Необов'язкові поля мають значення за замовчуванням у коді, що їх читає. */
export interface AppEnv {
  /** База D1 з таблицями з migrations/. */
  DB: D1Database;
  /** Workers AI; бот звертається до нього, коли інші провайдери ШІ недоступні. */
  AI?: Ai;

  /** Секрет: токен бота від @BotFather. */
  TELEGRAM_BOT_TOKEN: string;
  /** Секрет: довільний рядок (A-Z, a-z, 0-9, _ і -), яким Telegram підписує вебхук. */
  WEBHOOK_SECRET: string;
  /** Секрет: ключ Groq (console.groq.com). */
  GROQ_API_KEY?: string;
  /** Секрет: ключ Google AI Studio. */
  GEMINI_API_KEY?: string;
  /** Секрет: ключ довільного OpenAI-сумісного сервісу (наприклад, OpenRouter). */
  CUSTOM_AI_API_KEY?: string;

  /** Часовий пояс (IANA) для нових користувачів; без значення Europe/Kyiv. */
  DEFAULT_TZ?: string;
  /** Порядок провайдерів ШІ через кому: groq, gemini, custom, workers. */
  AI_PROVIDERS?: string;
  /** Моделі Groq через кому в порядку спроб. */
  GROQ_MODELS?: string;
  /** Модель Groq із підтримкою зображень; порожнє значення вимикає її. */
  GROQ_VISION_MODEL?: string;
  /** Моделі Gemini через кому в порядку спроб. */
  GEMINI_MODELS?: string;
  /** Базова адреса OpenAI-сумісного сервісу, без /chat/completions. */
  CUSTOM_AI_BASE_URL?: string;
  /** Моделі custom-сервісу через кому в порядку спроб. */
  CUSTOM_AI_MODELS?: string;
  /** "1" чи "true", якщо моделі custom-сервісу розуміють зображення. */
  CUSTOM_AI_VISION?: string;
  /** Модель Workers AI. */
  WORKERS_AI_MODEL?: string;
  /** Запитів до ШІ на користувача за день; без значення 40. */
  AI_DAILY_LIMIT?: string;
  /** Id користувачів Telegram через кому, яким дозволено бота; порожньо означає всіх. */
  ALLOWED_USERS?: string;
  /** Id адміністраторів Telegram через кому. */
  ADMIN_ID?: string;

  /** Адреса Bot API; підміняється лише в локальних тестах. */
  TELEGRAM_API_BASE?: string;
  /** Адреси провайдерів ШІ; підміняються лише в локальних тестах. */
  GROQ_BASE_URL?: string;
  GEMINI_BASE_URL?: string;
}

/** Розбиває рядок "a, b,,c" на непорожні елементи. */
export function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Ціле число зі змінної оточення або `fallback`, якщо змінна порожня чи некоректна. */
export function intVar(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Часовий пояс для нових користувачів. */
export function defaultTz(env: AppEnv): string {
  return env.DEFAULT_TZ?.trim() || 'Europe/Kyiv';
}

/** Чи дозволено цьому користувачу користуватися ботом (порожній ALLOWED_USERS дозволяє всім). */
export function isAllowed(env: AppEnv, userId: number): boolean {
  const allowed = list(env.ALLOWED_USERS);
  return allowed.length === 0 || allowed.includes(String(userId));
}

/** Чи є користувач адміністратором (його id є в ADMIN_ID). */
export function isAdmin(env: AppEnv, userId: number): boolean {
  return list(env.ADMIN_ID).includes(String(userId));
}
