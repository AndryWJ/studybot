/**
 * Підписані посилання на сторінку графіків. У посиланні є id користувача і
 * термін дії, а підпис HMAC-SHA256 на основі WEBHOOK_SECRET не дає підставити
 * чужий id: без секрету правильний підпис не обчислити.
 */

import type { AppEnv } from '../env';

/** Скільки діє посилання на графіки, секунд. */
export const CHART_LINK_TTL = 24 * 3600;

function base64url(bytes: ArrayBuffer): string {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))).slice(0, 32);
}

/** Посилання на графіки користувача `userId`, дійсне CHART_LINK_TTL секунд від `now`. `origin` без кінцевого "/". */
export async function chartsUrl(env: AppEnv, origin: string, userId: number, now: number): Promise<string> {
  const exp = now + CHART_LINK_TTL;
  const sig = await hmac(env.WEBHOOK_SECRET, `charts:${userId}:${exp}`);
  return `${origin}/charts?u=${userId}&e=${exp}&s=${sig}`;
}

/** Перевіряє параметри посилання; повертає id користувача або null, якщо підпис неправильний чи термін минув. */
export async function verifyChartsUrl(env: AppEnv, url: URL, now: number): Promise<number | null> {
  const u = Number(url.searchParams.get('u'));
  const exp = Number(url.searchParams.get('e'));
  const sig = url.searchParams.get('s') ?? '';
  if (!Number.isSafeInteger(u) || !Number.isSafeInteger(exp) || exp < now || !env.WEBHOOK_SECRET) return null;
  const expected = await hmac(env.WEBHOOK_SECRET, `charts:${u}:${exp}`);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? u : null;
}
