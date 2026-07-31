/**
 * @fileoverview Sends people to the right language. Deliberately checks nobody, so this
 * file declares no guard and no door — the framework runs it by name and nothing else.
 */
export function middleware(request: { url: string }) {
  return { redirect: `${request.url}?lang=en` };
}
