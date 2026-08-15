// The risk the relaxation creates, kept where it will be noticed if it comes back.
//
// `looksLikeRouter` accepts `api` on the name alone — no binding required — and this is a
// Koa repository, so a rule that asked "is this project Koa?" rather than "is this holder
// a Koa router?" would hand these two the relaxed path rule and book them as ways in.
// They are an HTTP client and a cache, which is what `api` and `r` usually are.
import Redis from 'ioredis';

const api = { get: async (p: string) => ({ p }), post: async (p: string) => ({ p }) };
const r = new Redis();

export async function fetchUsers() {
  return api.get('users');
}

export async function recordEvent() {
  await api.post('events/created');
  return r.get('events:count');
}
