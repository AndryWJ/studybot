/**
 * Точка входу Cloudflare Worker.
 *
 * HTTP-маршрути:
 * - POST /webhook: оновлення від Telegram (перевіряється секретний заголовок);
 * - GET /setup?secret=...: одноразове налаштування вебхука, команд і опису бота
 *   з перевіркою бази та ключів ШІ;
 * - GET /charts?...: сторінка графіків за підписаним посиланням із бота;
 * - GET /: коротка перевірка, що Worker живий.
 * scheduled(): щохвилинна фонова робота (src/cron.ts).
 */

import { providersFromEnv } from './ai/client';
import { handleUpdate } from './bot/router';
import { COMMANDS } from './bot/ui';
import { runCron } from './cron';
import { Db } from './db';
import type { AppEnv } from './env';
import { escapeHtml } from './format';
import { Telegram, type TgUpdate } from './telegram';
import { expiredPage, renderCharts } from './web/charts';
import { verifyChartsUrl } from './web/sign';

const SECRET_FORMAT = /^[A-Za-z0-9_-]{16,256}$/;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
    },
  });
}

interface Check {
  ok: boolean | 'warn';
  title: string;
  detail: string;
}

/** Налаштовує бота в Telegram і перевіряє, чи все готово до роботи. */
async function setup(env: AppEnv, origin: string): Promise<Response> {
  const checks: Check[] = [];
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN ?? '', env.TELEGRAM_API_BASE);

  let botName = '';
  try {
    const me = await tg.call<{ username: string; first_name: string }>('getMe');
    botName = me.username;
    checks.push({ ok: true, title: 'Токен бота', detail: `бот @${me.username} (${me.first_name})` });
  } catch (e) {
    checks.push({ ok: false, title: 'Токен бота', detail: `Telegram не прийняв токен: ${e instanceof Error ? e.message : String(e)}. Перевірте секрет TELEGRAM_BOT_TOKEN.` });
  }

  if (botName) {
    try {
      await tg.call('setWebhook', {
        url: `${origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query', 'poll_answer', 'my_chat_member'],
        max_connections: 20,
      });
      checks.push({ ok: true, title: 'Вебхук', detail: `${origin}/webhook` });
    } catch (e) {
      checks.push({ ok: false, title: 'Вебхук', detail: e instanceof Error ? e.message : String(e) });
    }
    try {
      const commands = COMMANDS;
      await tg.call('setMyCommands', { commands });
      await tg.call('setMyCommands', { commands, language_code: 'uk' });
      await tg.call('setMyShortDescription', { short_description: 'Розклад, дедлайни з нагадуваннями, план до НМТ, конспекти, тести й оцінки.' });
      await tg.call('setMyDescription', {
        description:
          'StudyBot допомагає вчитися без авралів: розклад, дедлайни з нагадуваннями й пріоритетами, план підготовки до НМТ та іспитів ' +
          'з розрахунком годин на кожен предмет, розбивка завдань на кроки, конспекти й тести, таймер, прогрес і середній бал.',
      });
      checks.push({ ok: true, title: 'Меню команд і опис', detail: `${commands.length} команд` });
    } catch (e) {
      checks.push({ ok: 'warn', title: 'Меню команд і опис', detail: e instanceof Error ? e.message : String(e) });
    }
  }

  try {
    await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    await env.DB.prepare('SELECT COUNT(*) AS n FROM grades').first();
    checks.push({ ok: true, title: 'База D1', detail: 'таблиці на місці' });
  } catch (e) {
    checks.push({
      ok: false,
      title: 'База D1',
      detail: `таблиць немає або база не підключена (${e instanceof Error ? e.message : String(e)}). Виконайте npm run db:migrate і перевірте database_id у wrangler.jsonc.`,
    });
  }

  const providers = providersFromEnv(env);
  checks.push(
    providers.length
      ? { ok: true, title: 'ШІ', detail: `порядок спроб: ${providers.map((p) => p.id).join(', ')}` }
      : { ok: 'warn', title: 'ШІ', detail: 'жодного провайдера: конспекти, тести й поради працювати не будуть. Додайте GROQ_API_KEY.' },
  );
  if (!providers.some((p) => p.vision)) {
    checks.push({ ok: 'warn', title: 'Фото', detail: 'немає ШІ з підтримкою зображень, тож фото сторінок не розпізнаються (необов\'язково).' });
  }

  const allOk = checks.every((c) => c.ok !== false);
  const rows = checks
    .map((c) => `<li class="${c.ok === true ? 'ok' : c.ok === 'warn' ? 'warn' : 'bad'}"><b>${c.ok === true ? '✅' : c.ok === 'warn' ? '⚠️' : '❌'} ${escapeHtml(c.title)}</b><br>${escapeHtml(c.detail)}</li>`)
    .join('');
  const link = botName ? `<p><a href="https://t.me/${escapeHtml(botName)}">Відкрити @${escapeHtml(botName)} у Telegram</a></p>` : '';
  return html(`<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Налаштування StudyBot</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:0 auto;padding:16px;background:Canvas;color:CanvasText}
ul{padding:0;list-style:none}li{border:1px solid color-mix(in srgb,CanvasText 15%,transparent);border-radius:12px;padding:10px 12px;margin:8px 0;overflow-wrap:anywhere}
.bad{border-color:#d03b3b}.warn{border-color:#fab219}</style></head>
<body><h1>${allOk ? 'StudyBot готовий 🎉' : 'Потрібно щось виправити'}</h1><ul>${rows}</ul>${link}
<p>Цю сторінку можна відкривати повторно: налаштування просто оновляться.</p></body></html>`, allOk ? 200 : 500);
}

/** Обробники Worker-а: `fetch` маршрутизує HTTP-запити, `scheduled` запускає щохвилинну фонову роботу. */
export default {
  /** Маршрутизує запит за шляхом і методом (див. заголовок файлу); інші дають 404. Оновлення Telegram обробляється у фоні через `waitUntil`, тож відповідь йому не чекає на ШІ. */
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (!env.WEBHOOK_SECRET || !safeEqual(request.headers.get('x-telegram-bot-api-secret-token') ?? '', env.WEBHOOK_SECRET)) {
        return new Response('forbidden', { status: 403 });
      }
      let update: TgUpdate;
      try {
        update = await request.json();
      } catch {
        return new Response('bad request', { status: 400 });
      }
      // Відповідаємо Telegram одразу, а обробка (часто з ШІ) триває у фоні до 30 секунд.
      ctx.waitUntil(handleUpdate(env, update, url.origin).catch((e) => console.error('handleUpdate crashed', e)));
      return new Response('ok');
    }

    if (url.pathname === '/setup' && request.method === 'GET') {
      if (!env.WEBHOOK_SECRET || !SECRET_FORMAT.test(env.WEBHOOK_SECRET)) {
        return html('<h1>WEBHOOK_SECRET не задано або він закороткий</h1><p>Задайте секрет із 16+ символів (латиниця, цифри, _ та -): <code>npx wrangler secret put WEBHOOK_SECRET</code>.</p>', 500);
      }
      if (!safeEqual(url.searchParams.get('secret') ?? '', env.WEBHOOK_SECRET)) return new Response('forbidden', { status: 403 });
      return setup(env, url.origin);
    }

    if (url.pathname === '/charts' && request.method === 'GET') {
      const now = Math.floor(Date.now() / 1000);
      const userId = await verifyChartsUrl(env, url, now);
      if (userId === null) return html(expiredPage(), 403);
      const db = new Db(env.DB);
      const user = await db.getUser(userId);
      if (!user) return html(expiredPage(), 404);
      return html(await renderCharts(db, user, now));
    }

    if (url.pathname === '/' && request.method === 'GET') {
      return new Response('StudyBot працює. Налаштування: /setup?secret=...', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return new Response('not found', { status: 404 });
  },

  /** Запуск за розкладом Cron Trigger. `controller.scheduledTime` у мілісекундах, у runCron передається в секундах. */
  async scheduled(controller: ScheduledController, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env, Math.floor(controller.scheduledTime / 1000)));
  },
} satisfies ExportedHandler<AppEnv>;
