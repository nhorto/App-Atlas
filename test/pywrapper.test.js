/**
 * @fileoverview Outgoing calls made through a wrapper the project wrote itself (item 42).
 *
 * `healthchecks/healthchecks` exists to notify people, and the boundary view said it
 * talked to one outside company: email. Its 282 other requests all go through
 * `hc/lib/curl.py` — "a requests-like interface for PycURL" — so no call site imports an
 * HTTP library, and the per-file readers saw a method call on a local name and stopped.
 * "1 company, none of which receive data from you" is the sentence that produced, about
 * a product whose whole job is sending your status to eleven others.
 *
 * The fixture keeps every shape that repo uses, because each one failed differently:
 * the address as a class constant handed to `self.post`, as an f-string, as a plain
 * local variable, as printf formatting over a class constant, and written out at a
 * direct call to the wrapper.
 *
 * Two classes here both call their address `URL`, which is the trap: a flat namespace
 * hands the first one's company to all of them, and a wrong company named on a boundary
 * card is worse than a blank one.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'pywrapper'), {
  followReferences: true,
  cache: 'off',
});

const services = atlas.nodes.filter((n) => n.kind === 'service');
const named = (name) => services.find((n) => n.name === name);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
});

test('a first-party wrapper around an HTTP client is an HTTP client', () => {
  // `curl.post("https://slack.com/api/oauth.v2.access", …)`. Nothing at that call site
  // names a library; `lib/curl.py` is the only file in the project that imports one.
  const slack = named('Slack');
  assert.ok(slack, `no Slack: ${services.map((s) => s.name).join(', ')}`);
  assert.deepEqual(slack.meta.hosts, ['slack.com']);
});

test('an address held as a class constant and posted through self is a call', () => {
  // `self.post(self.URL, …)`, four layers above the client. Neither the library nor
  // the address is visible on that line, but the address is one line up.
  assert.ok(named('Pushover'), 'the class constant was not followed');
});

test('an f-string keeps whatever host it got out before the placeholder', () => {
  // `f"https://api.telegram.org/bot{token}/sendMessage"` leaves the host intact. A
  // `f"https://{host}/x"` leaves nothing that parses, and is refused by the same rule.
  assert.ok(named('Telegram'));
});

test('a local variable on the line above the request counts, and the default wins', () => {
  // Opsgenie is assigned once and then conditionally overwritten with its EU host. The
  // first is the deployment nobody configured, so it is the one to name.
  const opsgenie = named('Opsgenie');
  assert.ok(opsgenie);
  assert.deepEqual(opsgenie.meta.hosts, ['api.opsgenie.com']);
});

test('printf formatting over a class constant is followed one hop', () => {
  // `url = self.URL % account_id`, still the oldest way to build a URL in Python.
  assert.ok(named('Twilio'));
});

test('two classes that both call their address URL keep their own', () => {
  // The reason class constants are scoped to their class. Flat, `TwilioTransport` would
  // have inherited Pushover's address and the card would name the wrong company.
  assert.deepEqual(named('Twilio').meta.hosts, ['api.twilio.com']);
  assert.deepEqual(named('Pushover').meta.hosts, ['api.pushover.net']);
});

test('nothing is named that the code does not name', () => {
  assert.deepEqual(
    services.map((s) => s.name).sort(),
    ['Opsgenie', 'Pushover', 'Slack', 'Telegram', 'Twilio'],
  );
});
