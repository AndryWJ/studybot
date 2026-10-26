/**
 * Допоміжне для інтеграційних тестів: підміна fetch, що імітує Telegram Bot API
 * і OpenAI-сумісний ШІ, та конструктори оновлень Telegram.
 */

import { vi } from 'vitest';
import type { TgUpdate } from '../src/telegram';

/** Один виклик Bot API: назва методу й тіло запиту. */
export interface TgCall {
  method: string;
  params: Record<string, any>;
}

/** Журнал викликів і керування підміною fetch. */
export interface FetchMock {
  /** Усі виклики Bot API по порядку. */
  calls: TgCall[];
  /** Тіла запитів до ШІ. */
  aiRequests: Array<Record<string, any>>;
  /** Тексти надісланих повідомлень. */
  sent(): string[];
  /** Останній виклик методу `method`. */
  last(method: string): TgCall | undefined;
  /** Що відповідатиме ШІ на наступні запити. */
  setAi(fn: (body: Record<string, any>) => string | Response): void;
  restore(): void;
}

/** Підміняє глобальний fetch. Повертає журнал викликів. */
export function mockFetch(): FetchMock {
  const calls: TgCall[] = [];
  const aiRequests: Array<Record<string, any>> = [];
  let ai: (body: Record<string, any>) => string | Response = () => 'Відповідь ШІ';
  let messageId = 100;
  let pollId = 0;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://telegram.test/file/')) return new Response(new Uint8Array([0xff, 0xd8, 0xff]));
    if (url.startsWith('https://telegram.test/bot')) {
      const method = url.split('/').pop()!;
      const params = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ method, params });
      let result: unknown = true;
      if (method === 'sendMessage') result = { message_id: ++messageId, chat: { id: params.chat_id, type: 'private' }, date: 0, text: params.text };
      if (method === 'sendPoll') result = { message_id: ++messageId, chat: { id: params.chat_id, type: 'private' }, date: 0, poll: { id: `poll-${++pollId}` } };
      if (method === 'getMe') result = { id: 1, is_bot: true, first_name: 'StudyBot', username: 'test_study_bot' };
      if (method === 'getFile') result = { file_id: params.file_id, file_path: 'photos/file_1.jpg' };
      return Response.json({ ok: true, result });
    }
    if (url.startsWith('https://groq.test/')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      aiRequests.push(body);
      const out = ai(body);
      if (out instanceof Response) return out;
      return Response.json({ choices: [{ message: { role: 'assistant', content: out }, finish_reason: 'stop' }] });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  return {
    calls,
    aiRequests,
    sent: () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.params.text)),
    last: (method) => [...calls].reverse().find((c) => c.method === method),
    setAi: (fn) => {
      ai = fn;
    },
    restore: () => spy.mockRestore(),
  };
}

let updateId = 1;

/** Оновлення з текстовим повідомленням у приватному чаті; id чату збігається з id користувача. */
export function textUpdate(text: string, userId = 1001, firstName = 'Оля'): TgUpdate {
  return {
    update_id: updateId++,
    message: { message_id: updateId, from: { id: userId, is_bot: false, first_name: firstName }, chat: { id: userId, type: 'private' }, date: 0, text },
  };
}

/** Оновлення з натисканням кнопки з `data` під повідомленням `messageId`. */
export function callbackUpdate(data: string, userId = 1001, messageId = 555, messageText = ''): TgUpdate {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: userId, is_bot: false, first_name: 'Оля' },
      data,
      message: { message_id: messageId, chat: { id: userId, type: 'private' }, date: 0, text: messageText },
    },
  };
}

/** Оновлення з відповіддю користувача в опитуванні: обрано варіант `option` (з нуля). */
export function pollAnswerUpdate(pollId: string, option: number, userId = 1001): TgUpdate {
  return { update_id: updateId++, poll_answer: { poll_id: pollId, user: { id: userId, is_bot: false, first_name: 'Оля' }, option_ids: [option] } };
}

/** Знаходить callback_data кнопки з текстом, що містить `label`, в останній клавіатурі виклику. */
export function findButton(call: TgCall | undefined, label: string): string | undefined {
  const rows: Array<Array<{ text: string; callback_data?: string }>> = call?.params.reply_markup?.inline_keyboard ?? [];
  return rows.flat().find((b) => b.text.includes(label))?.callback_data;
}

/** Unix-секунди для київського часу (UTC+2 узимку, UTC+3 улітку) через Date.UTC зі зсувом. */
export function kyiv(year: number, month: number, day: number, hour = 12, minute = 0, offsetHours = 2): number {
  return Date.UTC(year, month - 1, day, hour - offsetHours, minute) / 1000;
}
