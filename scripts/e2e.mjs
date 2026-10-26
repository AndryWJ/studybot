#!/usr/bin/env node
/**
 * Наскрізна перевірка бота на локальному Worker-і без справжнього Telegram і ШІ.
 *
 * Скрипт піднімає підставний сервер, що відповідає як Telegram Bot API і як
 * OpenAI-сумісний ШІ, запускає `wrangler dev --local` з окремою локальною базою,
 * надсилає на вебхук оновлення так, ніби пише користувач, викликає щохвилинну
 * фонову задачу і перевіряє, що бот відповів очікувано. Нічого в Cloudflare
 * не створює і з мережею, крім localhost, не працює.
 *
 * Запуск: npm run e2e  (параметр --keep залишає сервер працювати для ручних перевірок)
 */

import { spawn, execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, '.wrangler', 'e2e-state');
const OUT = path.join(ROOT, '.wrangler', 'e2e-out');
const MOCK_PORT = 8790;
const DEV_PORT = 8787;
const SECRET = 'e2e_secret_0123456789';
const USER = 4242;
const KEEP = process.argv.includes('--keep');

const calls = [];
let messageId = 1000;
let pollId = 0;

/** Відповіді підставного ШІ залежно від того, що просить системний промпт. */
function aiAnswer(body) {
  const system = String(body.messages?.[0]?.content ?? '');
  if (system.includes('Склади тест')) {
    return JSON.stringify({
      title: 'Київська Русь',
      questions: [
        { q: 'Хто хрестив Русь?', options: ['Володимир Великий', 'Ярослав Мудрий', 'Ольга', 'Святослав'], correct: 0, explain: 'У 988 році.' },
        { q: 'Столиця Київської Русі?', options: ['Чернігів', 'Київ', 'Новгород', 'Галич'], correct: 1, explain: 'Київ.' },
        { q: 'Збірка законів Ярослава?', options: ['Руська правда', 'Литовський статут', 'Конституція Орлика', 'Магдебурзьке право'], correct: 0, explain: 'Руська правда.' },
      ],
    });
  }
  if (system.includes('Розбий велике')) {
    return JSON.stringify({
      title: 'Курсова з історії',
      steps: [
        { text: 'Обрати тему і погодити з викладачем', minutes: 30 },
        { text: 'Знайти 10 джерел', minutes: 90 },
        { text: 'Скласти план', minutes: 45 },
        { text: 'Написати вступ і перший розділ', minutes: 120 },
      ],
      tip: 'Пиши щодня потроху.',
    });
  }
  if (system.includes('конспект')) return '**Київська Русь**\n\n- Держава IX-XIII ст.\n- Столиця Київ\n\nПитання: хто хрестив Русь?';
  return 'Ось пояснення: **дріб** це частина цілого. Наприклад, 1/2.';
}

function startMock() {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '';
      const send = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (url.startsWith('/ai/chat/completions')) {
        const body = JSON.parse(raw || '{}');
        calls.push({ method: 'AI', params: body });
        return send({ choices: [{ message: { role: 'assistant', content: aiAnswer(body) }, finish_reason: 'stop' }] });
      }
      if (url.startsWith('/file/')) {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      }
      const m = /^\/bot[^/]+\/(\w+)/.exec(url);
      if (!m) return send({ ok: false, description: 'not found' }, 404);
      const method = m[1];
      const params = raw ? JSON.parse(raw) : {};
      calls.push({ method, params });
      let result = true;
      if (method === 'sendMessage') result = { message_id: ++messageId, chat: { id: params.chat_id, type: 'private' }, date: 0, text: params.text };
      if (method === 'sendPoll') result = { message_id: ++messageId, chat: { id: params.chat_id, type: 'private' }, date: 0, poll: { id: `poll-${++pollId}` } };
      if (method === 'getMe') result = { id: 1, is_bot: true, first_name: 'StudyBot', username: 'e2e_study_bot' };
      if (method === 'getFile') result = { file_id: params.file_id, file_path: 'photos/p.jpg' };
      send({ ok: true, result });
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrangler = (args) =>
  execFileSync('npx', ['wrangler', ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, CI: 'true' } });

function sql(command) {
  const out = wrangler(['d1', 'execute', 'studybot', '--local', '--persist-to', STATE, '--json', '--command', command]);
  return JSON.parse(out)[0]?.results ?? [];
}

let updateId = 1;
async function post(update) {
  const res = await fetch(`http://127.0.0.1:${DEV_PORT}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify({ update_id: updateId++, ...update }),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
}

const from = { id: USER, is_bot: false, first_name: 'Тест' };
const chat = { id: USER, type: 'private' };
const say = (text) => post({ message: { message_id: updateId, from, chat, date: 0, text } });
const press = (data, text = '') => post({ callback_query: { id: `cq${updateId}`, from, data, message: { message_id: 1, chat, date: 0, text } } });

/** Чекає, поки підставний сервер отримає виклик, що задовольняє умову; повертає його. */
async function waitFor(predicate, startIndex, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const found = calls.slice(startIndex).find(predicate);
    if (found) return found;
    await sleep(100);
  }
  return null;
}

const results = [];
async function step(name, run) {
  const start = calls.length;
  try {
    const detail = await run(start);
    results.push({ name, ok: true, detail: detail ?? '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

const sentWith = (start, needle) => waitFor((c) => c.method === 'sendMessage' && String(c.params.text).includes(needle), start);
function expect(cond, message) {
  if (!cond) throw new Error(message);
}
function button(call, label) {
  return (call?.params.reply_markup?.inline_keyboard ?? []).flat().find((b) => b.text.includes(label));
}

async function main() {
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const mock = await startMock();
  console.log('Застосовую міграції до локальної бази...');
  wrangler(['d1', 'migrations', 'apply', 'studybot', '--local', '--persist-to', STATE]);

  const vars = {
    TELEGRAM_BOT_TOKEN: 'e2e-token',
    WEBHOOK_SECRET: SECRET,
    TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    GROQ_API_KEY: 'e2e-key',
    GROQ_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/ai`,
    AI_PROVIDERS: 'groq',
    GROQ_MODELS: 'e2e-model',
  };
  const envFile = path.join(OUT, 'e2e.env');
  writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n'));
  console.log('Запускаю wrangler dev...');
  const dev = spawn(
    'npx',
    ['wrangler', 'dev', '--local', '--test-scheduled', '--port', String(DEV_PORT), '--persist-to', STATE, '--env-file', envFile, '--show-interactive-dev-session=false'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true' }, detached: true },
  );
  // wrangler працює в окремій групі процесів, тож Ctrl+C треба передати їй явно.
  const stopDev = () => {
    try {
      process.kill(-dev.pid, 'SIGTERM');
    } catch {
      dev.kill('SIGTERM');
    }
  };
  process.on('SIGINT', () => {
    stopDev();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    stopDev();
    process.exit(143);
  });
  let devLog = '';
  dev.stdout.on('data', (d) => (devLog += d));
  dev.stderr.on('data', (d) => (devLog += d));

  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await sleep(500);
      up = await fetch(`http://127.0.0.1:${DEV_PORT}/`).then((r) => r.ok, () => false);
    }
    if (!up) throw new Error(`wrangler dev не запустився:\n${devLog}`);

    await step('webhook відхиляє запит без секрету', async () => {
      const res = await fetch(`http://127.0.0.1:${DEV_PORT}/webhook`, { method: 'POST', body: '{}' });
      expect(res.status === 403, `очікував 403, отримав ${res.status}`);
    });

    await step('/setup налаштовує вебхук і перевіряє базу', async (start) => {
      const res = await fetch(`http://127.0.0.1:${DEV_PORT}/setup?secret=${SECRET}`);
      const html = await res.text();
      expect(res.status === 200, `HTTP ${res.status}: ${html.slice(0, 300)}`);
      const hook = calls.slice(start).find((c) => c.method === 'setWebhook');
      expect(hook?.params.allowed_updates.includes('poll_answer'), 'setWebhook без poll_answer');
      expect(html.includes('StudyBot готовий'), 'сторінка не каже, що все готово');
    });

    await step('/start вітає', async (start) => {
      await say('/start');
      expect(await sentWith(start, 'Привіт, Тест'), 'немає привітання');
    });

    await step('дедлайн із вільного тексту без ШІ', async (start) => {
      await say('нагадай здати реферат з біології післязавтра о 10');
      const msg = await sentWith(start, 'Здати реферат з біології');
      expect(msg, 'немає підтвердження');
      expect(!calls.slice(start).some((c) => c.method === 'AI'), 'дедлайн не мав іти в ШІ');
      expect(button(msg, 'висока'), 'немає кнопок важливості');
    });

    await step('розклад: додати заняття текстом', async (start) => {
      await press('sch:add');
      await sentWith(start, 'день час назва');
      const s2 = calls.length;
      await say('пн-пт 08:30-14:00 Уроки\nвт, чт 16:00 Футбол');
      expect(await sentWith(s2, 'Додав у розклад'), 'не додано');
    });

    await step('розбити завдання на кроки (ШІ)', async (start) => {
      await press('tk:new');
      await sentWith(start, 'Опиши велике завдання');
      const s2 = calls.length;
      await say('написати курсову з історії через 10 днів');
      const card = await sentWith(s2, 'Курсова з історії');
      expect(card, 'немає картки завдання');
      expect(button(card, '1'), 'немає кнопок кроків');
    });

    await step('план підготовки до іспитів з розрахунком 12 годин', async (start) => {
      await press('pl:k:exam');
      await sentWith(start, 'Напиши предмети');
      const d = (n) => {
        const t = new Date(Date.now() + n * 86400000);
        return `${String(t.getUTCDate()).padStart(2, '0')}.${String(t.getUTCMonth() + 1).padStart(2, '0')}.${t.getUTCFullYear()}`;
      };
      const s2 = calls.length;
      await say(`Вища математика ${d(10)}\nФізика ${d(14)}\nАнглійська ${d(20)}`);
      const rate = await sentWith(s2, 'Оціни кожен предмет');
      expect(rate, 'немає кроку оцінювання');
      const s3 = calls.length;
      await press('pl:r:d:0');
      await press('pl:r:d:0');
      await press('pl:r:l:2');
      await waitFor((c) => c.method === 'editMessageText', s3);
      const s4 = calls.length;
      await press('pl:r:ok');
      await sentWith(s4, 'Скільки годин усього');
      const s5 = calls.length;
      await say('12');
      const preview = await sentWith(s5, 'Розрахунок часу');
      expect(preview, 'немає розрахунку');
      expect(String(preview.params.text).includes('12 год'), 'у плані не 12 годин');
      const s6 = calls.length;
      await press('pl:save');
      expect(await sentWith(s6, 'План збережено'), 'план не збережено');
      const rows = sql(`SELECT subject, SUM(minutes) AS m FROM steps WHERE user_id = ${USER} AND subject IS NOT NULL GROUP BY subject ORDER BY m DESC`);
      return rows.map((r) => `${r.subject}: ${r.m / 60} год`).join(', ');
    });

    await step('тест-вікторина з балами', async (start) => {
      await say('❓ Тест');
      await sentWith(start, 'Про що тест');
      const s2 = calls.length;
      await say('Київська Русь');
      const poll = await waitFor((c) => c.method === 'sendPoll', s2);
      expect(poll?.params.type === 'quiz' && poll.params.is_anonymous === false && Array.isArray(poll.params.correct_option_ids), 'неправильні параметри sendPoll');
      for (let i = 1; i <= 3; i++) {
        const prev = calls.filter((c) => c.method === 'sendPoll').at(-1);
        const s = calls.length;
        await post({ poll_answer: { poll_id: `poll-${pollId}`, user: from, option_ids: prev.params.correct_option_ids } });
        if (i < 3) await waitFor((c) => c.method === 'sendPoll', s);
        else expect(await sentWith(s, 'Результат: <b>3 з 3</b>'), 'немає результату 3 з 3');
      }
    });

    await step('оцінки і скільки треба для 10', async (start) => {
      await press('gr:add');
      await sentWith(start, 'Напиши оцінки');
      const s2 = calls.length;
      await say('Математика 8 9 7\nФізика 10 11x2');
      await sentWith(s2, 'Записав 5');
      const s3 = calls.length;
      await press('gr:target');
      await sentWith(s3, 'Для якого предмета');
      const s4 = calls.length;
      await press('gr:s:0');
      await sentWith(s4, 'Яку підсумкову');
      const s5 = calls.length;
      await press('gr:g:0:10');
      const msg = await sentWith(s5, 'середній має бути від 9,5');
      expect(msg, 'немає розрахунку');
    });

    await step('ручний запис часу і прогрес з графіками', async (start) => {
      await press('tm:log');
      await sentWith(start, 'скільки часу і з якого предмета');
      const s2 = calls.length;
      await say('45 хв фізика');
      await sentWith(s2, 'Записав 45 хв');
      sql(
        `INSERT INTO study_log (user_id, subject, minutes, day, created_at) VALUES ` +
          [1, 2, 3, 4, 5, 6, 8, 9, 10, 12]
            .map((ago, i) => {
              const day = new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
              return `(${USER}, '${['Вища математика', 'Фізика', 'Англійська', 'Хімія'][i % 4]}', ${30 + ((i * 17) % 70)}, '${day}', 0)`;
            })
            .join(', '),
      );
      const s3 = calls.length;
      await say('📊 Прогрес');
      const msg = await sentWith(s3, 'Прогрес');
      expect(String(msg?.params.text).includes('Час навчання за 7 днів'), 'немає текстового графіка');
      // Локальний сервер працює по HTTP, а Telegram приймає Mini App лише за HTTPS, тому кнопки
      // тут немає; посилання підписуємо так само, як це робить src/web/sign.ts.
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const sig = createHmac('sha256', SECRET).update(`charts:${USER}:${exp}`).digest('base64url').slice(0, 32);
      const web = { web_app: { url: `http://127.0.0.1:${DEV_PORT}/charts?u=${USER}&e=${exp}&s=${sig}` } };
      const res = await fetch(web.web_app.url);
      const html = await res.text();
      expect(res.status === 200 && html.includes('Час навчання по днях'), `сторінка графіків: HTTP ${res.status}`);
      writeFileSync(path.join(OUT, 'charts.html'), html);
      const bad = await fetch(web.web_app.url.replace(/s=[^&]+/, 's=AAAA'));
      expect(bad.status === 403, 'підроблений підпис не відхилено');
      return `сторінку збережено в ${path.join(OUT, 'charts.html')}`;
    });

    await step('щохвилинна задача надсилає нагадування один раз', async (start) => {
      sql(`UPDATE reminders SET remind_at = strftime('%s','now') - 60 WHERE id = (SELECT MIN(id) FROM reminders WHERE user_id = ${USER} AND sent = 0)`);
      const res = await fetch(`http://127.0.0.1:${DEV_PORT}/__scheduled?cron=*+*+*+*+*`);
      expect(res.ok, `scheduled HTTP ${res.status}`);
      expect(await sentWith(start, 'Нагадування'), 'нагадування не надіслано');
      const s2 = calls.length;
      await fetch(`http://127.0.0.1:${DEV_PORT}/__scheduled?cron=*+*+*+*+*`);
      await sleep(1500);
      expect(!calls.slice(s2).some((c) => c.method === 'sendMessage' && String(c.params.text).includes('Нагадування')), 'нагадування надіслано вдруге');
    });

    await step('вільне питання йде до ШІ-репетитора', async (start) => {
      await say('Що таке дріб?');
      expect(await sentWith(start, 'дріб'), 'немає відповіді');
      expect(calls.slice(start).some((c) => c.method === 'AI'), 'ШІ не викликано');
    });
  } finally {
    const failed = results.filter((r) => !r.ok);
    console.log('\nРезультати:');
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
    console.log(`\n${results.length - failed.length}/${results.length} кроків пройдено.`);
    if (failed.length) console.log(`\nЛог wrangler dev (кінець):\n${devLog.slice(-3000)}`);
    if (KEEP) {
      console.log(`\nСервер працює: http://127.0.0.1:${DEV_PORT}. Ctrl+C, щоб зупинити.`);
      await new Promise(() => undefined);
    }
    stopDev();
    mock.close();
    process.exit(failed.length ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
