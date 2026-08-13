/**
 * @fileoverview How a door is written down when part of its address could not be read
 * (#245).
 *
 * Some frameworks assemble the head of an address while the process boots, out of things
 * that are not in any source file:
 *
 *   router.prefix = router.prefix ?? `/${pluginName}`   // Strapi, from a plugin registry
 *   this.apiPath  = [apiPath, version].filter(Boolean).join('/')   // Rocket.Chat
 *   app.get(`${relativePath}/ping`, …)                  // NodeBB, from a deploy setting
 *
 * The tail is a fact in every one of those. The head is not knowable without running the
 * program. Printing `/settings` when the truth is `/upload/settings` is the failure this
 * codebase is built against — wrong, confident, and nothing about it looks wrong — and
 * printing nothing is the other one, because silence reads as "no route here".
 *
 * So the answer is the tail with an ellipsis where the head would be. That answer had
 * been arrived at twice independently — once for a Gin group whose prefix lives with a
 * caller nothing connected (#151), once for a NestJS `@Controller()` whose argument is
 * not a literal (#153) — and written out twice, in two files, in two spellings. This is
 * the one spelling, so that the next detector to need it finds it rather than inventing a
 * third.
 *
 * ## The two rules it carries
 *
 * **Two unread addresses are never one door.** `…/` in Strapi's upload plugin and `…/` in
 * its i18n plugin have the same name and nothing else; merging them would pool whatever
 * check either one carries onto both. So the key is the file plus whatever tells two
 * same-named doors apart in that detector's world — the controller class for Nest (#159:
 * a v1/v2 split puts a `UsersController` in two files), the router and handler for a
 * mount (#151: realworld registers `ArticleList` on both its public and its authed
 * group). Each caller passes what discriminates; the shape is shared.
 *
 * **`route` goes to null.** Everything downstream that matches a prefix, sniffs a webhook
 * out of an address, or pairs a cron with a route is asking a question about a whole
 * address, and a fragment cannot answer it. The label keeps the tail so a reader can see
 * what the door is; `route` is what the machinery reads, and it says "unknown" because
 * that is true.
 */
import type { EndpointFinding } from './types.js';

/**
 * The door as it should be written when its head is unread.
 *
 * `discriminators` are what tell two same-named doors apart, and are joined into the key
 * in the order given — a null is kept as an empty segment rather than dropped, so a door
 * that has the thing and a door that does not can never key alike. `label` is the name in
 * the parenthesis: `POST …` on its own sends a reader searching, and the parenthesis is
 * the way back to the code.
 */
export function unreadHead(
  finding: EndpointFinding,
  discriminators: (string | null)[],
  label: string | null,
): EndpointFinding {
  const method = finding.method ?? 'ANY';
  const tail = finding.route ?? '';
  const parts = discriminators.map((part) => part ?? '').join('#');
  return {
    ...finding,
    key: `${method} ${finding.site.path}#${parts}${tail}`,
    name: `${method} …${tail}${label ? ` (${label})` : ''}`,
    route: null,
  };
}

/**
 * The discriminators and label for a door whose prefix was supposed to arrive from a
 * mount that never turned up, or that the detector knows was never written down.
 *
 * The router and the handler, because one function answering two mounts is two doors —
 * and a closure has no handler id, so the line stands in for it. This is the default for
 * any detector that has nothing more specific: file plus line is unique per declaration,
 * which is the weakest thing that still keeps strangers apart.
 */
export function unreadFromSite(finding: EndpointFinding): EndpointFinding {
  const handler =
    finding.handlerId?.startsWith('func:') === true
      ? finding.handlerId.slice(finding.handlerId.lastIndexOf('#') + 1)
      : null;
  return unreadHead(
    finding,
    [finding.routerVar ?? null, finding.handlerId ?? `L${finding.site.line}`],
    handler,
  );
}
