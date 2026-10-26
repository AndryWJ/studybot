/**
 * Звернення до мовних моделей із запасними варіантами.
 *
 * Провайдери перебираються в порядку AI_PROVIDERS: якщо один повернув помилку,
 * вичерпав безкоштовний ліміт (HTTP 429) чи не вклався в час, запит іде до
 * наступного. Groq, Gemini і "custom" говорять OpenAI-сумісним протоколом
 * (/chat/completions), Workers AI викликається через прив'язку env.AI.
 *
 * Обмеження платформи: на безкоштовному тарифі Cloudflare робота після відповіді
 * Telegram-у триває не довше 30 секунд, тому всі спроби разом укладаються в
 * бюджет часу `budgetMs`.
 */

import { list, type AppEnv } from '../env';

/** Текстовий фрагмент повідомлення. */
export interface AiTextPart {
  type: 'text';
  text: string;
}

/** Зображення в повідомленні; `url` це data:-URL чи адреса, доступна провайдеру. */
export interface AiImagePart {
  type: 'image_url';
  image_url: { url: string };
}

/** Повідомлення розмови; `content` це текст або набір частин з картинками. */
export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<AiTextPart | AiImagePart>;
}

/** Запит до моделі. Без `maxTokens` і `temperature` провайдери беруть 1200 і 0,5. */
export interface AiRequest {
  messages: AiMessage[];
  /** Просити відповідь у форматі JSON-об'єкта. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

/** Джерело відповідей моделі. `complete` повертає непорожній текст або кидає помилку (ProviderError чи збій fetch); `signal` перериває запит за таймаутом. */
export interface Provider {
  /** Підпис для логів, наприклад "groq:openai/gpt-oss-120b". */
  id: string;
  /** Чи розуміє модель зображення в повідомленнях. */
  vision: boolean;
  complete(req: AiRequest, signal: AbortSignal): Promise<string>;
}

/** Помилка провайдера; `status`: HTTP-статус відповіді, якщо він був. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Жоден провайдер не дав придатної відповіді. `attempts`: що сталося з кожним.
 * `consumed`: хоча б один провайдер відповів (токени витрачено), але відповідь не підійшла.
 */
export class AiUnavailableError extends Error {
  constructor(
    readonly attempts: string[],
    readonly consumed = false,
  ) {
    super(attempts.length ? `AI unavailable: ${attempts.join(' | ')}` : 'AI providers are not configured');
  }
}

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

interface CompatibleConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  vision: boolean;
  /** Провайдер підтримує response_format {type: "json_object"}. */
  jsonObject: boolean;
  /** Додаткові поля тіла запиту, специфічні для провайдера. */
  extra?: Record<string, unknown>;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : ''))
      .join('');
  }
  return '';
}

/** Провайдер, сумісний з OpenAI Chat Completions API. */
export function openAiCompatible(cfg: CompatibleConfig): Provider {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return {
    id: cfg.id,
    vision: cfg.vision,
    async complete(req, signal) {
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: req.messages,
        max_tokens: req.maxTokens ?? 1200,
        temperature: req.temperature ?? 0.5,
        ...cfg.extra,
      };
      if (req.json && cfg.jsonObject) body.response_format = { type: 'json_object' };

      const send = (payload: Record<string, unknown>) =>
        fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        });

      let res = await send(body);
      // Частина моделей не приймає response_format чи додаткові поля і відповідає 400:
      // тоді повторюємо з мінімальним тілом, а JSON просимо лише текстом промпту.
      if (res.status === 400 && (body.response_format || cfg.extra)) {
        await res.body?.cancel();
        res = await send({ model: body.model, messages: body.messages, max_tokens: body.max_tokens, temperature: body.temperature });
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new ProviderError(`HTTP ${res.status} ${detail}`, res.status);
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }> };
      const text = textOf(data.choices?.[0]?.message?.content).trim();
      if (!text) throw new ProviderError(`empty answer (finish_reason: ${data.choices?.[0]?.finish_reason ?? 'n/a'})`);
      return text;
    },
  };
}

/**
 * Дістає текст із відповіді env.AI.run. Різні моделі Workers AI повертають різну
 * форму: старі моделі `{response}`, новіші OpenAI-подібні `{choices}`, а gpt-oss
 * може повертати `{output: [...]}` у стилі Responses API.
 */
export function workersAiText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  if (typeof r.response === 'string') return r.response;
  if (r.response && typeof r.response === 'object') return JSON.stringify(r.response);
  const choices = r.choices as Array<{ message?: { content?: unknown } }> | undefined;
  if (Array.isArray(choices) && choices.length) return textOf(choices[0]?.message?.content);
  if (Array.isArray(r.output)) {
    return (r.output as Array<{ type?: string; content?: unknown }>)
      .filter((item) => item?.type === 'message')
      .map((item) => textOf(item.content))
      .join('');
  }
  return '';
}

/** Провайдер Workers AI через прив'язку env.AI. У запит іде лише текст повідомлень (зображення не підтримуються); спрацювання `signal` дає ProviderError "timeout". */
export function workersAi(ai: Ai, model: string): Provider {
  return {
    id: `workers:${model}`,
    vision: false,
    async complete(req, signal) {
      const run = (ai as unknown as { run(model: string, input: unknown): Promise<unknown> }).run(model, {
        messages: req.messages.map((m) => ({ role: m.role, content: textOf(m.content) })),
        max_tokens: req.maxTokens ?? 1200,
        temperature: req.temperature ?? 0.5,
      });
      const aborted = new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new ProviderError('timeout')), { once: true });
      });
      const text = workersAiText(await Promise.race([run, aborted])).trim();
      if (!text) throw new ProviderError('empty answer');
      return text;
    },
  };
}

/** Збирає список провайдерів з оточення в порядку AI_PROVIDERS; без ключа провайдер пропускається. */
export function providersFromEnv(env: AppEnv): Provider[] {
  const out: Provider[] = [];
  const order = list(env.AI_PROVIDERS ?? 'groq,gemini,custom,workers');
  for (const name of order) {
    if (name === 'groq' && env.GROQ_API_KEY) {
      const base = env.GROQ_BASE_URL || GROQ_BASE;
      for (const model of list(env.GROQ_MODELS ?? 'openai/gpt-oss-120b,openai/gpt-oss-20b')) {
        out.push(
          openAiCompatible({
            id: `groq:${model}`,
            baseUrl: base,
            apiKey: env.GROQ_API_KEY,
            model,
            vision: false,
            jsonObject: true,
            // gpt-oss на Groq міркує перед відповіддю; низький рівень економить токени ліміту.
            extra: model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : undefined,
          }),
        );
      }
      const visionModel = env.GROQ_VISION_MODEL?.trim();
      if (visionModel) {
        out.push(openAiCompatible({ id: `groq:${visionModel}`, baseUrl: base, apiKey: env.GROQ_API_KEY, model: visionModel, vision: true, jsonObject: true }));
      }
    } else if (name === 'gemini' && env.GEMINI_API_KEY) {
      for (const model of list(env.GEMINI_MODELS ?? 'gemini-3.5-flash-lite')) {
        out.push(
          openAiCompatible({
            id: `gemini:${model}`,
            baseUrl: env.GEMINI_BASE_URL || GEMINI_BASE,
            apiKey: env.GEMINI_API_KEY,
            model,
            vision: true,
            // Режим json_object у сумісному шарі Gemini не задокументований, тому JSON просимо промптом.
            jsonObject: false,
            extra: { reasoning_effort: 'low' },
          }),
        );
      }
    } else if (name === 'custom' && env.CUSTOM_AI_API_KEY && env.CUSTOM_AI_BASE_URL) {
      for (const model of list(env.CUSTOM_AI_MODELS)) {
        out.push(
          openAiCompatible({
            id: `custom:${model}`,
            baseUrl: env.CUSTOM_AI_BASE_URL,
            apiKey: env.CUSTOM_AI_API_KEY,
            model,
            vision: env.CUSTOM_AI_VISION === '1' || env.CUSTOM_AI_VISION === 'true',
            jsonObject: false,
          }),
        );
      }
    } else if (name === 'workers' && env.AI) {
      out.push(workersAi(env.AI, env.WORKERS_AI_MODEL?.trim() || '@cf/google/gemma-4-26b-a4b-it'));
    }
  }
  return out;
}

function hasImages(messages: AiMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
}

/** Параметри complete і completeJson. */
export interface CompleteOptions {
  /** Загальний бюджет часу на всі спроби, мс. */
  budgetMs?: number;
  /** Перевірка відповіді; якщо повертає false, бот пробує наступного провайдера. */
  accept?: (text: string) => boolean;
  /** Провайдери замість тих, що з оточення (для тестів). */
  providers?: Provider[];
}

/**
 * Надсилає запит першому провайдеру, що впорається.
 * Для повідомлень із зображеннями використовуються лише провайдери з vision.
 * Один провайдер отримує не більше 20 с; коли від бюджету лишається менше 2,5 с, спроби припиняються.
 * @throws AiUnavailableError, якщо ніхто не дав прийнятної відповіді.
 */
export async function complete(env: AppEnv, req: AiRequest, opts: CompleteOptions = {}): Promise<{ text: string; provider: string }> {
  const needVision = hasImages(req.messages);
  const providers = (opts.providers ?? providersFromEnv(env)).filter((p) => !needVision || p.vision);
  const deadline = Date.now() + (opts.budgetMs ?? 23000);
  const attempts: string[] = [];
  let consumed = false;
  for (const p of providers) {
    const remaining = deadline - Date.now();
    if (remaining < 2500) {
      attempts.push(`${p.id}: skipped, out of time`);
      break;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, 20000));
    try {
      const text = await p.complete(req, controller.signal);
      consumed = true;
      if (opts.accept && !opts.accept(text)) throw new ProviderError(`unusable answer: ${text.slice(0, 120)}`);
      return { text, provider: p.id };
    } catch (e) {
      const msg = controller.signal.aborted ? 'timeout' : e instanceof Error ? e.message : String(e);
      attempts.push(`${p.id}: ${msg}`);
      console.warn(`AI provider failed: ${p.id}: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new AiUnavailableError(attempts, consumed);
}

/**
 * Витягує JSON з відповіді моделі: прибирає обгортку ```json і пробує кожну
 * відкривальну дужку по черзі (до останньої закривальної того ж виду), прощаючи
 * зайві коми перед закривальною дужкою. Так текст на кшталт "Ось тест [JSON]: {...}"
 * не заважає. Перевага віддається об'єкту чи масиву об'єктів перед дрібницями на
 * кшталт "[1]". Повертає undefined, якщо JSON не знайдено.
 */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim().slice(0, 100_000);
  let fallback: unknown;
  let tries = 0;
  for (let start = 0; start < cleaned.length && tries < 20; start++) {
    const open = cleaned[start];
    if (open !== '{' && open !== '[') continue;
    tries++;
    const end = cleaned.lastIndexOf(open === '{' ? '}' : ']');
    if (end <= start) continue;
    const slice = cleaned.slice(start, end + 1);
    for (const candidate of [slice, slice.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        const value = JSON.parse(candidate);
        const structured = Array.isArray(value) ? value.length > 0 && value.every((x) => x && typeof x === 'object') : value && typeof value === 'object';
        if (structured) return value;
        fallback ??= value;
        break;
      } catch {
        // наступний кандидат
      }
    }
  }
  return fallback;
}

/**
 * Запит, відповідь на який має бути JSON-ом певної форми. `parse` перевіряє
 * й нормалізує дані та повертає null, якщо форма не та; тоді бот пробує
 * наступного провайдера.
 * @throws AiUnavailableError, якщо жоден провайдер не дав відповіді потрібної форми.
 */
export async function completeJson<T>(
  env: AppEnv,
  req: AiRequest,
  parse: (value: unknown) => T | null,
  opts: Omit<CompleteOptions, 'accept'> = {},
): Promise<{ data: T; provider: string }> {
  let parsed: T | null = null;
  const { provider } = await complete(env, { ...req, json: true }, {
    ...opts,
    accept: (text) => {
      parsed = parse(extractJson(text));
      return parsed !== null;
    },
  });
  return { data: parsed as unknown as T, provider };
}
