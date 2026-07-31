/**
 * @fileoverview Ports a Compose file publishes, and the ones it only exposes (#45).
 *
 * The whole risk of reading infrastructure is one keyword: `ports:` publishes to the
 * host, `expose:` opens a port to the other containers and to nobody else. Getting it
 * backwards in either direction is the over-claim this project exists to avoid — a door
 * invented out of nothing, or a real one hidden — so both directions are pinned here by
 * name, not by count.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';
import { readComposePorts } from '../dist/node/analyze/boundaries/compose.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'compose');

const ports = readComposePorts(FIXTURE);
const { atlas } = await analyzeProject(FIXTURE, { followReferences: true, cache: 'off' });
const doors = atlas.nodes.filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'port');

/** `file:line service bind:host→container/proto`, which is the whole fact in one string. */
const row = (p) =>
  `${p.configPath}:${p.line} ${p.target} ${p.bindAddress ?? '*'}:${
    p.hostPort ?? (p.hostPortVar ? `$${p.hostPortVar}` : '-')
  }→${p.containerPort}/${p.protocol}`;

test('every port spelling is read, and only the published ones', () => {
  assert.deepEqual(ports.map(row), [
    'docker-compose.override.yml:7 db *:15432→5432/tcp',
    'docker-compose.yml:15 db *:5432→5432/tcp',
    'docker-compose.yml:23 cache *:6379→6379/tcp',
    'docker-compose.yml:29 admin 127.0.0.1:8080→8080/tcp',
    'docker-compose.yml:34 metrics *:9091→9090/tcp',
    'docker-compose.yml:42 dns *:5353→53/udp',
    'docker-compose.yml:47 bulk *:8000-8010→8000-8010/tcp',
    'docker-compose.yml:52 scratch *:-→3000/tcp',
    'docker-compose.yml:56 web *:8081→80/tcp',
    'docker-compose.yml:61 console *:$CONSOLE_PORT→9443/tcp',
    'docker-compose.yml:66 secure [::1]:9444→443/tcp',
  ]);
});

test('`expose:` is not `ports:`, in either direction', () => {
  // `internal` and `sidecar` expose 9000, 9001 and 7000 between them. Not one of those
  // ports is reachable from the host, so not one of them may appear anywhere.
  assert.deepEqual(
    ports.filter((p) => p.target === 'internal' || p.target === 'sidecar'),
    [],
  );
  for (const exposed of ['9000', '9001', '7000']) {
    assert.equal(
      ports.some((p) => p.hostPort === exposed || p.containerPort === exposed),
      false,
      `${exposed} is exposed to the other containers, not published on the host`,
    );
  }
  // And the other direction: every service that does publish is still there.
  assert.deepEqual(
    [...new Set(ports.map((p) => p.target))].sort(),
    ['admin', 'bulk', 'cache', 'console', 'db', 'dns', 'metrics', 'scratch', 'secure', 'web'],
  );
});

test('the loopback binding is not the same as every interface', () => {
  const admin = ports.find((p) => p.target === 'admin');
  const db = ports.find((p) => p.configPath === 'docker-compose.yml' && p.target === 'db');
  assert.equal(admin.bindAddress, '127.0.0.1', 'this one only the machine itself can reach');
  assert.equal(db.bindAddress, null, 'and this one is on every interface, which is Docker default');
  assert.equal(ports.find((p) => p.target === 'secure').bindAddress, '[::1]');
});

test('an unquoted port mapping is read as text, never as a number', () => {
  // `6379:6379` unquoted is a legal YAML 1.1 sexagesimal integer, and a reader that
  // resolves it hands back 388740 rather than a port mapping.
  const cache = ports.find((p) => p.target === 'cache');
  assert.equal(cache.hostPort, '6379');
  assert.equal(cache.containerPort, '6379');
  assert.equal(cache.raw, '- 6379:6379');
});

test('the long form says the same thing the short form does', () => {
  const metrics = ports.find((p) => p.target === 'metrics');
  assert.equal(metrics.hostPort, '9091', '`published` is the host side');
  assert.equal(metrics.containerPort, '9090', '`target` is the container side');
  assert.equal(metrics.protocol, 'tcp');
});

test('a port whose number lives in an env file is a door with no number', () => {
  // `${CONSOLE_PORT}` carries no default, so the number is in somebody's .env. The door
  // is real; inventing a number for it is not on.
  const console_ = ports.find((p) => p.target === 'console');
  assert.equal(console_.hostPort, null);
  assert.equal(console_.hostPortVar, 'CONSOLE_PORT');
  // `${WEB_PORT:-8081}` does carry one, and the file's own default is a fact.
  assert.equal(ports.find((p) => p.target === 'web').hostPort, '8081');
});

test('`ports:` somewhere that is not a service attribute is not a port', () => {
  // One nested under `deploy.resources`, one inside a block scalar. A reader that
  // matched the keyword anywhere in the file would draw two doors nobody opened.
  for (const invented of ['6666', '9999']) {
    assert.equal(
      ports.some((p) => p.hostPort === invented),
      false,
      `${invented} is not a published port, whatever the file has the word "ports" near`,
    );
  }
  // And a file wearing the name with no `services:` in it claims nothing at all.
  assert.equal(
    ports.some((p) => p.configPath === 'docker-compose.notes.yml'),
    false,
  );
});

test('two Compose files are reported separately, never reconciled', () => {
  // Which files somebody runs together is not written down in the repo: `up` layers the
  // override onto the base, `-f` replaces it. So each declaration keeps its own file,
  // and the reader is told which file said what instead of one merged answer that no
  // single file supports.
  assert.deepEqual(
    ports.filter((p) => p.target === 'db').map((p) => `${p.configPath} ${p.hostPort}`).sort(),
    ['docker-compose.override.yml 15432', 'docker-compose.yml 5432'],
  );
});

test('the door names the file, not the machine', () => {
  assert.deepEqual(doors.map((n) => n.name).sort(), [
    'docker-compose.override.yml publishes 15432 on every interface → db',
    'docker-compose.yml publishes 5353/udp on every interface → dns',
    'docker-compose.yml publishes 5432 on every interface → db',
    'docker-compose.yml publishes 6379 on every interface → cache',
    'docker-compose.yml publishes 8000-8010 on every interface → bulk',
    'docker-compose.yml publishes 8080 on 127.0.0.1 only → admin',
    'docker-compose.yml publishes 8081 on every interface → web',
    'docker-compose.yml publishes 9091 on every interface → metrics',
    'docker-compose.yml publishes 9444 on [::1] only → secure',
    'docker-compose.yml publishes port 3000 inside the container, on a host port Docker picks → scratch',
    'docker-compose.yml publishes the port CONSOLE_PORT is set to, on every interface → console',
  ]);
});

test('the door points at the line that declared it', () => {
  const db = doors.find((n) => n.name.startsWith('docker-compose.yml publishes 5432'));
  assert.equal(db.meta.framework, 'Docker Compose');
  assert.equal(db.meta.sites[0].path, 'docker-compose.yml');
  assert.equal(db.meta.sites[0].line, 15);
  assert.equal(db.meta.sites[0].snippet, '- "5432:5432"');
  // No code in this repo answers it, so nothing is hung off a handler that is not there.
  assert.equal(
    atlas.edges.some((e) => e.fromId === db.id && e.kind === 'exposed-by'),
    false,
  );
});

test('published ports do not inflate the auth headline', () => {
  // A web server publishing port 80 is the point, not a finding. Eleven ports here and
  // not one of them may turn up in "N of M routes have no auth check": that count is
  // about doors a stranger knocks on that somebody meant to protect, and a headline
  // whose rows are mostly unalarming is one people learn to skip.
  assert.equal(doors.length, 11);
  assert.equal(atlas.meta.stats.routes, 0);
  assert.equal(atlas.meta.stats.unprotectedRoutes, 0);
  for (const door of doors) assert.equal(door.meta.open, undefined);
});

test('a repo with no Compose file gains nothing', () => {
  assert.deepEqual(readComposePorts(path.join(here, 'fixtures', 'worker')), []);
});
