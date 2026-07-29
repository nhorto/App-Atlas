/**
 * @fileoverview Security insight badges (SPEC.md 6.6).
 *
 * Three lists, in the order someone should read them: which doors nothing is
 * guarding, which companies get your data, and which environment variables you rely
 * on. Every line is compiler-derived, and where certainty ran out the badge says
 * "likely" rather than rounding up to "safe" — claiming a route is protected when it
 * is not would be the most damaging thing this tool could do.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { EnvVarInfo, InsightsView, Protection, RouteInsight, ServiceInsight } from '../types';

interface Props {
  insights: InsightsView;
  onReveal: (id: string) => void;
}

export function InsightsScreen({ insights, onReveal }: Props) {
  const { auth, services, stores, tables, env } = insights;

  return (
    <div className="insights">
      <AuthCoverage auth={auth} onReveal={onReveal} />
      <ExternalServices services={services} onReveal={onReveal} />
      <DataStores stores={stores} onReveal={onReveal} />
      <TableProtection tables={tables} onReveal={onReveal} />
      <EnvInventory env={env} />
      <p className="insights-foot">
        Everything on this page is derived from your code by the compiler. Nothing here was generated or guessed.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AuthCoverage({ auth, onReveal }: { auth: InsightsView['auth']; onReveal: (id: string) => void }) {
  const [showAll, setShowAll] = useState(false);

  if (auth.total === 0) {
    return (
      <Card title="Who can get in" subtitle="No routes, pages or server actions found in this project.">
        <p className="muted">
          Nothing here answers a URL, so there is nothing to protect. If that surprises you, the analyzer may not
          recognise your framework yet.
        </p>
      </Card>
    );
  }

  // Unexplained first, then the ones we could not examine, then everything else —
  // `byUrgency` in the model already put them in that order, so the only decision
  // left here is where to stop before the reader has to ask for more.
  const needsReading = auth.routes.filter(
    (route) => route.open?.kind === 'worth-a-look' || route.open?.kind === 'unreadable',
  );
  const rest = auth.routes.filter((route) => !needsReading.includes(route));
  const shown = showAll ? auth.routes : [...needsReading, ...rest.slice(0, 6)];

  const segments = [
    { count: auth.protectedCount, className: 'ok', label: 'checked' },
    { count: auth.likelyCount, className: 'maybe', label: 'probably checked' },
    { count: auth.unreadableCount, className: 'unknown', label: 'not examined' },
    { count: auth.publicCount, className: 'public', label: 'open on purpose' },
    { count: auth.openCount, className: 'open', label: 'nothing found' },
  ];

  return (
    <Card
      title="Who can get in"
      subtitle={`${auth.total} ${auth.total === 1 ? 'door' : 'doors'} a stranger could knock on`}
    >
      <div className="score">
        <Meter segments={segments} />
        <ul className="score-key">
          {segments
            .filter((segment) => segment.count > 0)
            .map((segment) => (
              <li key={segment.className}>
                <span className={`swatch swatch-${segment.className}`} /> {segment.count} {segment.label}
              </li>
            ))}
        </ul>
      </div>

      <ul className="route-list">
        {shown.map((route) => (
          <li key={route.id}>
            <button className="route" onClick={() => onReveal(route.id)}>
              <span className={`method method-${(route.method ?? 'any').toLowerCase()}`}>{route.method ?? 'ANY'}</span>
              <span className="route-name">{route.route ?? route.name}</span>
              {route.writes ? <span className="tag tag-write">writes data</span> : null}
              <ProtectionBadge route={route} />
            </button>
            <span className="route-path">
              {route.sites[0] ? `${route.sites[0].path}:${route.sites[0].line}` : null}
              {/* The reason a door is open belongs beside the door, not in a footnote
                  the reader reaches after they have already formed an impression. */}
              {route.open?.because ? <em className="route-why">{route.open.because}</em> : null}
            </span>
          </li>
        ))}
      </ul>

      {auth.routes.length > shown.length ? (
        <button className="btn-ghost" onClick={() => setShowAll(true)}>
          Show all {auth.routes.length}
        </button>
      ) : null}

      {auth.unread.length > 0 ? <UnreadFiles unread={auth.unread} /> : null}

      {auth.openCount > 0 ? (
        <p className="note">
          "Nothing found" means App Atlas could not see an auth check — not that the route is definitely
          exploitable. Doors it can explain — a page the browser renders, the address your auth provider is
          mounted at — are counted separately so this number stays worth reading.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * The one thing on this page that is not a fact about the code: a fact about the
 * analyzer. It goes here rather than in the warnings drawer because a check hiding in
 * a file we could not parse is the specific way every number above can be wrong.
 */
function UnreadFiles({ unread }: { unread: InsightsView['auth']['unread'] }) {
  return (
    <p className="note note-unknown">
      App Atlas could not read {unread.length} {unread.length === 1 ? 'file' : 'files'}, so anything they declare —
      including a check — is missing from the counts above:
      {' '}
      {unread.map((file, i) => (
        <span key={file.path}>
          {i > 0 ? ', ' : ''}
          <code title={file.because}>{file.path}</code>
        </span>
      ))}
    </p>
  );
}

function ProtectionBadge({ route }: { route: RouteInsight }) {
  const guard = route.guards[0];
  const label = openLabel(route) ?? (guard?.provider && guard.provider !== 'custom' ? guard.provider : (guard?.name ?? 'checked'));
  const tone = route.open ? badgeTone(route.open.kind) : route.protection;
  return (
    <span className={`badge badge-${tone}`} title={route.open?.because ?? guardTitle(route.guards)}>
      {route.protection === 'likely' ? `likely · ${label}` : label}
    </span>
  );
}

function openLabel(route: RouteInsight): string | null {
  switch (route.open?.kind) {
    case 'worth-a-look':
      return 'no check found';
    case 'unreadable':
      return 'not examined';
    case 'page':
      return 'public page';
    case 'auth-mount':
      return 'the sign-in door';
    default:
      return null;
  }
}

/** An unchecked door with a reason must not wear the same red as one without. */
function badgeTone(kind: NonNullable<RouteInsight['open']>['kind']): string {
  if (kind === 'worth-a-look') return 'open';
  if (kind === 'unreadable') return 'unknown';
  return 'public';
}

function guardTitle(guards: RouteInsight['guards']): string {
  if (guards.length === 0) return 'No authentication or authorization check was found for this endpoint.';
  return guards.map((g) => `${g.name} (${g.how}${g.path ? `, ${g.path}:${g.line ?? '?'}` : ''})`).join('\n');
}

interface MeterSegment {
  count: number;
  className: string;
  label: string;
}

function Meter({ segments }: { segments: MeterSegment[] }) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0) || 1;
  const described = segments
    .filter((segment) => segment.count > 0)
    .map((segment) => `${segment.count} ${segment.label}`)
    .join(', ');
  return (
    <div className="meter" role="img" aria-label={described || 'no doors'}>
      {segments.map((segment) => (
        <span
          key={segment.className}
          className={`meter-${segment.className}`}
          style={{ width: `${(segment.count / total) * 100}%` }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** "3 companies, 1 of which receives data from you" — without mangling the small cases. */
function serviceSubtitle(count: number, senders: number): string {
  const companies = `${count} ${count === 1 ? 'company' : 'companies'}`;
  if (senders === 0) return `${companies}, none of which receive data from you`;
  if (senders === count) {
    if (count === 1) return '1 company, and it receives data from you';
    return `${companies}, all of which receive data from you`;
  }
  return `${companies}, ${senders} of which ${senders === 1 ? 'receives' : 'receive'} data from you`;
}

function ExternalServices({ services, onReveal }: { services: ServiceInsight[]; onReveal: (id: string) => void }) {
  if (services.length === 0) {
    return (
      <Card title="Where your data goes" subtitle="No third-party services found.">
        <p className="muted">This app does not appear to send data to anyone else.</p>
      </Card>
    );
  }

  const senders = services.filter((service) => service.sends).length;
  return (
    <Card
      title="Where your data goes"
      subtitle={serviceSubtitle(services.length, senders)}
    >
      <ul className="service-list">
        {services.map((service) => (
          <li key={service.id}>
            <button onClick={() => onReveal(service.id)}>
              <span className="service-name">{service.name}</span>
              <span className="tag">{categoryLabel(service.category)}</span>
              {service.sends ? <span className="tag tag-send">sends data</span> : null}
              <span className="service-count">
                {service.callSites} {service.callSites === 1 ? 'call' : 'calls'}
              </span>
            </button>
            <span className="service-evidence">{service.evidence.join(' · ')}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DataStores({ stores, onReveal }: { stores: InsightsView['stores']; onReveal: (id: string) => void }) {
  if (stores.length === 0) return null;
  return (
    <Card title="Where your data lives" subtitle={`${stores.length} ${stores.length === 1 ? 'store' : 'stores'}`}>
      <ul className="service-list">
        {stores.map((store) => (
          <li key={store.id}>
            <button onClick={() => onReveal(store.id)}>
              <span className="service-name">{store.name}</span>
              <span className="tag">{store.client}</span>
              <span className="service-count">
                {store.reads} read{store.reads === 1 ? '' : 's'} · {store.writes} write{store.writes === 1 ? '' : 's'}
              </span>
            </button>
            {store.tables.length > 0 ? (
              <span className="service-evidence">{store.tables.join(', ')}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Row-level security, table by table. Shown only when the migrations actually said
 * something — a page of "unknown" would be noise wearing a badge. Tables the code
 * merely queries are summarised in one honest sentence instead of being rounded
 * up to "unprotected".
 */
function TableProtection({ tables, onReveal }: { tables: InsightsView['tables']; onReveal: (id: string) => void }) {
  const stated = tables.list.filter((table) => table.rls !== null);
  if (stated.length === 0) return null;

  return (
    <Card
      title="Who can touch your data"
      subtitle={`${stated.length} of ${tables.total} tables have their row security written in migrations`}
    >
      {tables.unprotected > 0 ? (
        <p className="note note-warn">
          {tables.unprotected} {tables.unprotected === 1 ? 'table has' : 'tables have'} row-level security switched
          off. If this database is reached with a published client key, those rows are open to whoever holds it.
        </p>
      ) : tables.locked > 0 ? (
        <p className="note note-warn">
          {tables.locked} {tables.locked === 1 ? 'table has' : 'tables have'} row security enabled but not a single
          policy — every request is denied. Usually a migration half-finished.
        </p>
      ) : (
        <p className="note note-ok">
          Every table the migrations declare has row-level security on, with at least one policy.
        </p>
      )}

      <ul className="service-list">
        {stated.map((table) => (
          <li key={table.id}>
            <button onClick={() => onReveal(table.id)}>
              <span className="service-name">{table.name}</span>
              {table.rls!.enabled ? (
                table.rls!.policyCount === 0 ? (
                  <span className="tag tag-send">locked · no policies</span>
                ) : (
                  <span className="tag">RLS on</span>
                )
              ) : (
                <span className="tag tag-send">no row security</span>
              )}
              <span className="service-count">
                {table.rls!.policyCount === 0
                  ? 'no policies'
                  : `${table.rls!.policyCount} ${table.rls!.policyCount === 1 ? 'policy' : 'policies'} · ${table
                      .rls!.commands.join(', ')}`}
              </span>
            </button>
            {table.path ? <span className="service-evidence">{table.path}</span> : null}
          </li>
        ))}
      </ul>

      {tables.unknown > 0 ? (
        <p className="muted">
          …and {tables.unknown} more {tables.unknown === 1 ? 'table' : 'tables'} seen only in queries — their
          protection lives in the database, not in this repo, so nothing is claimed either way.
        </p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function EnvInventory({ env }: { env: InsightsView['env'] }) {
  const [showAll, setShowAll] = useState(false);
  if (env.total === 0) return null;

  const shown = showAll ? env.vars : env.undocumented.length > 0 ? env.undocumented : env.vars.slice(0, 8);

  return (
    <Card
      title="Configuration & secrets"
      subtitle={`${env.total} environment ${env.total === 1 ? 'variable' : 'variables'} read${
        env.exampleFile ? `, checked against ${env.exampleFile}` : ''
      }`}
    >
      {!env.exampleFile ? (
        <p className="note">
          There is no <code>.env.example</code> in this project, so there is nothing to check the list against.
          Adding one makes the next person's setup possible.
        </p>
      ) : env.undocumented.length > 0 ? (
        <p className="note note-warn">
          {env.undocumented.length} {env.undocumented.length === 1 ? 'variable is' : 'variables are'} read by the
          code but missing from <code>{env.exampleFile}</code>.
        </p>
      ) : (
        <p className="note note-ok">Every variable the code reads is documented in {env.exampleFile}.</p>
      )}

      <ul className="env-list">
        {shown.map((entry) => (
          <li key={entry.name}>
            <EnvRow entry={entry} documented={Boolean(env.exampleFile)} />
          </li>
        ))}
      </ul>

      {env.vars.length > shown.length ? (
        <button className="btn-ghost" onClick={() => setShowAll(true)}>
          Show all {env.vars.length}
        </button>
      ) : null}
    </Card>
  );
}

function EnvRow({ entry, documented }: { entry: EnvVarInfo; documented: boolean }) {
  return (
    <>
      <span className="env-name mono">{entry.name}</span>
      {entry.secret ? <span className="tag tag-secret">secret</span> : null}
      {documented ? (
        <span className={`badge badge-${entry.documented ? 'protected' : 'open'}`}>
          {entry.documented ? 'documented' : 'undocumented'}
        </span>
      ) : null}
      <span className="env-sites">
        {entry.sites
          .slice(0, 3)
          .map((site) => `${site.path}:${site.line}`)
          .join(' · ')}
        {entry.sites.length > 3 ? ` +${entry.sites.length - 3}` : ''}
      </span>
    </>
  );
}

// ---------------------------------------------------------------------------

function Card({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="insight-card">
      <header>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </header>
      {children}
    </section>
  );
}

function categoryLabel(category: string): string {
  switch (category) {
    case 'payments':
      return 'Payments';
    case 'ai':
      return 'AI';
    case 'email':
      return 'Email';
    case 'sms':
      return 'SMS';
    case 'auth':
      return 'Accounts';
    case 'storage':
      return 'File storage';
    case 'analytics':
      return 'Analytics';
    case 'search':
      return 'Search';
    case 'monitoring':
      return 'Monitoring';
    case 'queue':
      return 'Jobs';
    default:
      return 'Service';
  }
}
