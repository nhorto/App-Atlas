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
  const { auth, services, stores, env } = insights;

  return (
    <div className="insights">
      <AuthCoverage auth={auth} onReveal={onReveal} />
      <ExternalServices services={services} onReveal={onReveal} />
      <DataStores stores={stores} onReveal={onReveal} />
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

  const open = auth.routes.filter((route) => route.protection === 'open');
  const rest = auth.routes.filter((route) => route.protection !== 'open');
  const shown = showAll ? auth.routes : [...open, ...rest.slice(0, 6)];

  return (
    <Card
      title="Who can get in"
      subtitle={`${auth.total} ${auth.total === 1 ? 'door' : 'doors'} a stranger could knock on`}
    >
      <div className="score">
        <Meter counts={[auth.protectedCount, auth.likelyCount, auth.openCount]} />
        <ul className="score-key">
          <li>
            <span className="swatch swatch-ok" /> {auth.protectedCount} checked
          </li>
          <li>
            <span className="swatch swatch-maybe" /> {auth.likelyCount} probably checked
          </li>
          <li>
            <span className="swatch swatch-open" /> {auth.openCount} nothing found
          </li>
        </ul>
      </div>

      <ul className="route-list">
        {shown.map((route) => (
          <li key={route.id}>
            <button className="route" onClick={() => onReveal(route.id)}>
              <span className={`method method-${(route.method ?? 'any').toLowerCase()}`}>{route.method ?? 'ANY'}</span>
              <span className="route-name">{route.route ?? route.name}</span>
              {route.writes ? <span className="tag tag-write">writes data</span> : null}
              <ProtectionBadge protection={route.protection} guards={route.guards} />
            </button>
            {route.sites[0] ? (
              <span className="route-path">
                {route.sites[0].path}:{route.sites[0].line}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      {auth.routes.length > shown.length ? (
        <button className="btn-ghost" onClick={() => setShowAll(true)}>
          Show all {auth.routes.length}
        </button>
      ) : null}

      {auth.openCount > 0 ? (
        <p className="note">
          "Nothing found" means App Atlas could not see an auth check — not that the route is definitely
          exploitable. A public marketing page belongs in this list; a server action that writes to your database
          does not.
        </p>
      ) : null}
    </Card>
  );
}

function ProtectionBadge({ protection, guards }: { protection: Protection; guards: RouteInsight['guards'] }) {
  const guard = guards[0];
  const label =
    protection === 'open'
      ? 'no check found'
      : `${guard?.provider && guard.provider !== 'custom' ? guard.provider : (guard?.name ?? 'checked')}`;
  return (
    <span className={`badge badge-${protection}`} title={guardTitle(guards)}>
      {protection === 'likely' ? `likely · ${label}` : label}
    </span>
  );
}

function guardTitle(guards: RouteInsight['guards']): string {
  if (guards.length === 0) return 'No authentication or authorization check was found for this endpoint.';
  return guards.map((g) => `${g.name} (${g.how}${g.path ? `, ${g.path}:${g.line ?? '?'}` : ''})`).join('\n');
}

function Meter({ counts }: { counts: [number, number, number] | number[] }) {
  const total = counts.reduce((sum, n) => sum + n, 0) || 1;
  const [ok, maybe, open] = counts;
  return (
    <div className="meter" role="img" aria-label={`${ok} checked, ${maybe} probably checked, ${open} unchecked`}>
      <span className="meter-ok" style={{ width: `${(ok / total) * 100}%` }} />
      <span className="meter-maybe" style={{ width: `${(maybe / total) * 100}%` }} />
      <span className="meter-open" style={{ width: `${(open / total) * 100}%` }} />
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
