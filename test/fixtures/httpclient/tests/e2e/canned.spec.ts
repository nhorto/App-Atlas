// A Playwright spec calling a *deployed* application over HTTP (#236).
//
// `api` is a request client, not a router: it is held in a variable the existing rule
// accepts on its name alone, and its methods are spelled `get`/`post`/`delete` with a
// path-shaped string first — the same five tokens a route registration is made of.
//
// What separates them is that nothing here registers anything. There is no handler. The
// second argument is a bag of query parameters, and the first call has no second argument
// at all, which in Express would register a route that answers nothing.
//
// Read as doors these are wrong three times over. They are not this application's routes;
// their real addresses carry the `/api/v1` this file never writes; and being found in a
// spec they are told "nobody outside a test run can knock on this" — said about
// `/api/v1/canned-responses`, which anybody with an account can call.
import { makeApi } from './utils/test';

declare const request: never;

export async function run(api: ReturnType<typeof makeApi>) {
  await api.delete('/livechat/users/agent/user1');
  await api.delete('/canned-responses', { _id: 'abc' });
  await api.get('/settings/Livechat_title');
  await api.post('/abac/attributes', { name: 'x' });
}
