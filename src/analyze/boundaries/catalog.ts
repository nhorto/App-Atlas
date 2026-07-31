/**
 * @fileoverview The service catalog — the names behind the packages and hostnames.
 *
 * "Your app sends data to Stripe" is a far more useful sentence than "your app calls
 * `api.stripe.com`", and it is the sentence the security badge in SPEC.md 6.6 needs.
 * This is a curated lookup, deliberately: a guessed vendor name would undermine the
 * promise that everything on the boundary view is a fact.
 *
 * Anything not in the catalog still appears — under its own hostname or package name.
 * The catalog only ever improves the label, never decides whether a call is real.
 */
import type { ServiceCategory, SignInKind, StoreKind } from '../../model/types.js';

export interface ServiceDef {
  name: string;
  category: ServiceCategory;
}

export interface StoreDef {
  /** Display name of the client library: Prisma, Drizzle, pg… */
  client: string;
  storeKind: StoreKind;
  /** Name of the store itself when the client does not tell us the engine. */
  fallbackName: string;
}

/** Package name → the company on the other end of the wire. */
const PACKAGE_SERVICES: Record<string, ServiceDef> = {
  // payments
  stripe: { name: 'Stripe', category: 'payments' },
  '@stripe/stripe-js': { name: 'Stripe', category: 'payments' },
  '@paddle/paddle-node-sdk': { name: 'Paddle', category: 'payments' },
  '@lemonsqueezy/lemonsqueezy.js': { name: 'Lemon Squeezy', category: 'payments' },
  square: { name: 'Square', category: 'payments' },
  '@paypal/checkout-server-sdk': { name: 'PayPal', category: 'payments' },
  // ai
  openai: { name: 'OpenAI', category: 'ai' },
  '@anthropic-ai/sdk': { name: 'Anthropic', category: 'ai' },
  '@google/generative-ai': { name: 'Google Gemini', category: 'ai' },
  '@google/genai': { name: 'Google Gemini', category: 'ai' },
  cohere: { name: 'Cohere', category: 'ai' },
  'cohere-ai': { name: 'Cohere', category: 'ai' },
  replicate: { name: 'Replicate', category: 'ai' },
  '@huggingface/inference': { name: 'Hugging Face', category: 'ai' },
  groq: { name: 'Groq', category: 'ai' },
  'groq-sdk': { name: 'Groq', category: 'ai' },
  '@mistralai/mistralai': { name: 'Mistral', category: 'ai' },
  '@ai-sdk/openai': { name: 'OpenAI', category: 'ai' },
  '@ai-sdk/anthropic': { name: 'Anthropic', category: 'ai' },
  // email & messaging
  resend: { name: 'Resend', category: 'email' },
  '@sendgrid/mail': { name: 'SendGrid', category: 'email' },
  postmark: { name: 'Postmark', category: 'email' },
  mailgun: { name: 'Mailgun', category: 'email' },
  'mailgun.js': { name: 'Mailgun', category: 'email' },
  nodemailer: { name: 'Email (SMTP)', category: 'email' },
  '@aws-sdk/client-ses': { name: 'Amazon SES', category: 'email' },
  loops: { name: 'Loops', category: 'email' },
  twilio: { name: 'Twilio', category: 'sms' },
  '@slack/web-api': { name: 'Slack', category: 'other' },
  '@slack/bolt': { name: 'Slack', category: 'other' },
  'discord.js': { name: 'Discord', category: 'other' },
  '@octokit/rest': { name: 'GitHub', category: 'other' },
  octokit: { name: 'GitHub', category: 'other' },
  // auth — hosted only; see the note below about the libraries that are not companies
  '@clerk/nextjs': { name: 'Clerk', category: 'auth' },
  '@clerk/clerk-sdk-node': { name: 'Clerk', category: 'auth' },
  '@clerk/backend': { name: 'Clerk', category: 'auth' },
  '@auth0/nextjs-auth0': { name: 'Auth0', category: 'auth' },
  'auth0': { name: 'Auth0', category: 'auth' },
  '@workos-inc/node': { name: 'WorkOS', category: 'auth' },
  // storage
  '@aws-sdk/client-s3': { name: 'Amazon S3', category: 'storage' },
  '@vercel/blob': { name: 'Vercel Blob', category: 'storage' },
  cloudinary: { name: 'Cloudinary', category: 'storage' },
  uploadthing: { name: 'UploadThing', category: 'storage' },
  '@google-cloud/storage': { name: 'Google Cloud Storage', category: 'storage' },
  // analytics & monitoring
  'posthog-node': { name: 'PostHog', category: 'analytics' },
  'posthog-js': { name: 'PostHog', category: 'analytics' },
  '@segment/analytics-node': { name: 'Segment', category: 'analytics' },
  mixpanel: { name: 'Mixpanel', category: 'analytics' },
  '@amplitude/analytics-node': { name: 'Amplitude', category: 'analytics' },
  '@vercel/analytics': { name: 'Vercel Analytics', category: 'analytics' },
  '@sentry/node': { name: 'Sentry', category: 'monitoring' },
  '@sentry/nextjs': { name: 'Sentry', category: 'monitoring' },
  '@sentry/react': { name: 'Sentry', category: 'monitoring' },
  'dd-trace': { name: 'Datadog', category: 'monitoring' },
  '@logtail/node': { name: 'Better Stack', category: 'monitoring' },
  // search & vectors
  algoliasearch: { name: 'Algolia', category: 'search' },
  '@elastic/elasticsearch': { name: 'Elasticsearch', category: 'search' },
  meilisearch: { name: 'Meilisearch', category: 'search' },
  typesense: { name: 'Typesense', category: 'search' },
  '@pinecone-database/pinecone': { name: 'Pinecone', category: 'search' },
  '@qdrant/js-client-rest': { name: 'Qdrant', category: 'search' },
  // realtime & queues
  pusher: { name: 'Pusher', category: 'other' },
  ably: { name: 'Ably', category: 'other' },
  inngest: { name: 'Inngest', category: 'queue' },
  '@trigger.dev/sdk': { name: 'Trigger.dev', category: 'queue' },
  '@upstash/qstash': { name: 'Upstash QStash', category: 'queue' },
};

/**
 * Auth packages that are libraries, not companies (#30).
 *
 * `next-auth`, `@auth/core`, `lucia` and `better-auth` run inside the app and keep
 * their sessions in the app's own database. Nothing about installing one sends a user's
 * data anywhere, so listing them under "companies you send data to" is false in the one
 * place a reader is least able to check it — and it sits next to Stripe and OpenAI,
 * which are true, so it borrows their credibility.
 *
 * They stay in `AUTH_PROVIDERS` below, because naming the provider behind a guard is a
 * different claim and a correct one. Clerk, Auth0 and WorkOS are hosted: your app calls
 * their servers, so they belong in the catalog above.
 */
const IN_PROCESS_AUTH = new Set(['next-auth', '@auth/core', 'lucia', 'better-auth', 'iron-session', 'passport']);

/**
 * The same idea for Python, where the import name is the thing to look up.
 *
 * Kept separate rather than merged, because the two ecosystems disagree: `redis` is a
 * database client in both, but `openai` is a package name in one and an import name in
 * the other, and a shared table would quietly claim a Node app uses `boto3`.
 */
const PYTHON_SERVICES: Record<string, ServiceDef> = {
  stripe: { name: 'Stripe', category: 'payments' },
  openai: { name: 'OpenAI', category: 'ai' },
  anthropic: { name: 'Anthropic', category: 'ai' },
  cohere: { name: 'Cohere', category: 'ai' },
  replicate: { name: 'Replicate', category: 'ai' },
  together: { name: 'Together AI', category: 'ai' },
  google: { name: 'Google APIs', category: 'other' },
  resend: { name: 'Resend', category: 'email' },
  sendgrid: { name: 'SendGrid', category: 'email' },
  postmarker: { name: 'Postmark', category: 'email' },
  smtplib: { name: 'Email (SMTP)', category: 'email' },
  twilio: { name: 'Twilio', category: 'sms' },
  slack_sdk: { name: 'Slack', category: 'other' },
  slack: { name: 'Slack', category: 'other' },
  discord: { name: 'Discord', category: 'other' },
  github: { name: 'GitHub', category: 'other' },
  boto3: { name: 'Amazon Web Services', category: 'storage' },
  cloudinary: { name: 'Cloudinary', category: 'storage' },
  sentry_sdk: { name: 'Sentry', category: 'monitoring' },
  posthog: { name: 'PostHog', category: 'analytics' },
  segment: { name: 'Segment', category: 'analytics' },
  algoliasearch: { name: 'Algolia', category: 'search' },
  elasticsearch: { name: 'Elasticsearch', category: 'search' },
  pinecone: { name: 'Pinecone', category: 'search' },
  qdrant_client: { name: 'Qdrant', category: 'search' },
  supabase: { name: 'Supabase', category: 'other' },
  clerk_backend_api: { name: 'Clerk', category: 'auth' },
};

/** Python import name → the database client it is. */
const PYTHON_STORES: Record<string, StoreDef> = {
  sqlalchemy: { client: 'SQLAlchemy', storeKind: 'sql', fallbackName: 'Database' },
  sqlmodel: { client: 'SQLModel', storeKind: 'sql', fallbackName: 'Database' },
  django: { client: 'Django ORM', storeKind: 'sql', fallbackName: 'Database' },
  psycopg: { client: 'psycopg', storeKind: 'sql', fallbackName: 'PostgreSQL' },
  psycopg2: { client: 'psycopg2', storeKind: 'sql', fallbackName: 'PostgreSQL' },
  asyncpg: { client: 'asyncpg', storeKind: 'sql', fallbackName: 'PostgreSQL' },
  sqlite3: { client: 'sqlite3', storeKind: 'sql', fallbackName: 'SQLite' },
  aiosqlite: { client: 'aiosqlite', storeKind: 'sql', fallbackName: 'SQLite' },
  pymysql: { client: 'PyMySQL', storeKind: 'sql', fallbackName: 'MySQL' },
  peewee: { client: 'Peewee', storeKind: 'sql', fallbackName: 'Database' },
  tortoise: { client: 'Tortoise ORM', storeKind: 'sql', fallbackName: 'Database' },
  pymongo: { client: 'PyMongo', storeKind: 'nosql', fallbackName: 'MongoDB' },
  motor: { client: 'Motor', storeKind: 'nosql', fallbackName: 'MongoDB' },
  redis: { client: 'redis-py', storeKind: 'kv', fallbackName: 'Redis' },
  firebase_admin: { client: 'Firebase', storeKind: 'nosql', fallbackName: 'Firestore' },
};

/** Hostname → the company on the other end. Matched against literal URLs in `fetch`. */
const HOST_SERVICES: { pattern: RegExp; def: ServiceDef }[] = [
  { pattern: /(^|\.)stripe\.com$/, def: { name: 'Stripe', category: 'payments' } },
  { pattern: /(^|\.)openai\.com$/, def: { name: 'OpenAI', category: 'ai' } },
  { pattern: /(^|\.)anthropic\.com$/, def: { name: 'Anthropic', category: 'ai' } },
  { pattern: /(^|\.)googleapis\.com$/, def: { name: 'Google APIs', category: 'other' } },
  { pattern: /(^|\.)github\.com$/, def: { name: 'GitHub', category: 'other' } },
  { pattern: /(^|\.)slack\.com$/, def: { name: 'Slack', category: 'other' } },
  { pattern: /(^|\.)discord\.com$/, def: { name: 'Discord', category: 'other' } },
  { pattern: /(^|\.)resend\.com$/, def: { name: 'Resend', category: 'email' } },
  { pattern: /(^|\.)sendgrid\.com$/, def: { name: 'SendGrid', category: 'email' } },
  { pattern: /(^|\.)twilio\.com$/, def: { name: 'Twilio', category: 'sms' } },
  { pattern: /(^|\.)supabase\.co$/, def: { name: 'Supabase', category: 'other' } },
  { pattern: /(^|\.)clerk\.(com|dev|accounts\.dev)$/, def: { name: 'Clerk', category: 'auth' } },
  { pattern: /(^|\.)amazonaws\.com$/, def: { name: 'Amazon Web Services', category: 'storage' } },
  { pattern: /(^|\.)cloudinary\.com$/, def: { name: 'Cloudinary', category: 'storage' } },
  { pattern: /(^|\.)posthog\.com$/, def: { name: 'PostHog', category: 'analytics' } },
  { pattern: /(^|\.)sentry\.io$/, def: { name: 'Sentry', category: 'monitoring' } },
  { pattern: /(^|\.)algolia(net)?\.(com|net)$/, def: { name: 'Algolia', category: 'search' } },
  { pattern: /(^|\.)upstash\.io$/, def: { name: 'Upstash', category: 'other' } },
  { pattern: /(^|\.)vercel\.(com|app)$/, def: { name: 'Vercel', category: 'other' } },
];

/** Package name → the database client it is. */
const STORE_CLIENTS: Record<string, StoreDef> = {
  '@prisma/client': { client: 'Prisma', storeKind: 'sql', fallbackName: 'Database' },
  'drizzle-orm': { client: 'Drizzle', storeKind: 'sql', fallbackName: 'Database' },
  kysely: { client: 'Kysely', storeKind: 'sql', fallbackName: 'Database' },
  knex: { client: 'Knex', storeKind: 'sql', fallbackName: 'Database' },
  pg: { client: 'pg', storeKind: 'sql', fallbackName: 'PostgreSQL' },
  postgres: { client: 'postgres.js', storeKind: 'sql', fallbackName: 'PostgreSQL' },
  '@neondatabase/serverless': { client: 'Neon', storeKind: 'sql', fallbackName: 'Neon Postgres' },
  '@vercel/postgres': { client: 'Vercel Postgres', storeKind: 'sql', fallbackName: 'PostgreSQL' },
  mysql2: { client: 'mysql2', storeKind: 'sql', fallbackName: 'MySQL' },
  'better-sqlite3': { client: 'better-sqlite3', storeKind: 'sql', fallbackName: 'SQLite' },
  sequelize: { client: 'Sequelize', storeKind: 'sql', fallbackName: 'Database' },
  typeorm: { client: 'TypeORM', storeKind: 'sql', fallbackName: 'Database' },
  mongoose: { client: 'Mongoose', storeKind: 'nosql', fallbackName: 'MongoDB' },
  mongodb: { client: 'MongoDB driver', storeKind: 'nosql', fallbackName: 'MongoDB' },
  '@supabase/supabase-js': { client: 'Supabase', storeKind: 'sql', fallbackName: 'Supabase Postgres' },
  'firebase-admin': { client: 'Firebase', storeKind: 'nosql', fallbackName: 'Firestore' },
  '@upstash/redis': { client: 'Upstash Redis', storeKind: 'kv', fallbackName: 'Redis' },
  ioredis: { client: 'ioredis', storeKind: 'kv', fallbackName: 'Redis' },
  redis: { client: 'redis', storeKind: 'kv', fallbackName: 'Redis' },
  '@vercel/kv': { client: 'Vercel KV', storeKind: 'kv', fallbackName: 'Vercel KV' },
};

/** Package → the auth provider it belongs to, for labelling guards. */
const AUTH_PROVIDERS: { prefix: string; name: string }[] = [
  { prefix: '@clerk/', name: 'Clerk' },
  { prefix: 'next-auth', name: 'NextAuth' },
  { prefix: '@auth/', name: 'Auth.js' },
  { prefix: '@auth0/', name: 'Auth0' },
  { prefix: 'auth0', name: 'Auth0' },
  { prefix: '@supabase/', name: 'Supabase' },
  { prefix: 'better-auth', name: 'Better Auth' },
  { prefix: 'lucia', name: 'Lucia' },
  { prefix: '@workos-inc/', name: 'WorkOS' },
  { prefix: 'passport', name: 'Passport' },
  { prefix: 'jsonwebtoken', name: 'JWT' },
  { prefix: 'jose', name: 'JWT' },
];

/** An auth library's own way in or out, and which library's it is. */
export interface AuthEntryPoint {
  /** Spelled the way `authProviderForPackage` spells it, so the two can be compared. */
  provider: string;
  what: SignInKind;
}

/**
 * Calls that hand out a session, end one, or start the flow that leads to one.
 *
 * Curated exactly like the service catalog above, and for a sharper reason: this table
 * decides whether a door stops being reported as unguarded, so a guess belongs nowhere
 * near it. Every entry is a *library's* published API — `supabase.auth.signUp` is
 * GoTrue's shape, not one repository's — matched against the shape of the call and
 * never against the name of the function the call sits in.
 *
 * The pattern is anchored on the namespace rather than on the receiver because the
 * receiver is almost never resolvable: apps build their Supabase client in their own
 * `utils/supabase/server.ts` wrapper, so `supabase` traces back to the repo, not to the
 * package. That is the same reasoning that already lets `*.auth.getUser` count as a
 * guard in `auth.ts`, and the project's declared dependencies are what gate it.
 *
 * Deliberately absent: everything that acts on a session which already exists.
 * `auth.updateUser`, `auth.getUser`, `auth.refreshSession` and every `admin.*` call
 * need a signed-in caller, and excusing a door because it changes somebody's password
 * or signs another user out is precisely the mistake this table exists to avoid.
 */
const AUTH_ENTRY_CALLS: { methods: string[]; namespace: RegExp; entry: AuthEntryPoint }[] = [
  // Supabase / GoTrue: everything hangs off the client's own `.auth`. Requiring that
  // last segment to be `auth` is also what keeps `auth.admin.signOut` — signing
  // *somebody else* out with a service key — from ever reaching this table.
  {
    methods: [
      'signInWithPassword',
      'signInWithOtp',
      'signInWithOAuth',
      'signInWithIdToken',
      'signInWithSSO',
      'signInAnonymously',
      'verifyOtp',
      'exchangeCodeForSession',
    ],
    namespace: /(^|\.)auth$/,
    entry: { provider: 'Supabase', what: 'sign-in' },
  },
  { methods: ['signUp'], namespace: /(^|\.)auth$/, entry: { provider: 'Supabase', what: 'sign-up' } },
  { methods: ['signOut'], namespace: /(^|\.)auth$/, entry: { provider: 'Supabase', what: 'sign-out' } },
  {
    methods: ['resetPasswordForEmail'],
    namespace: /(^|\.)auth$/,
    entry: { provider: 'Supabase', what: 'password reset' },
  },
  // Better Auth reaches the same routines from the server through `auth.api.<name>`.
  {
    methods: ['signInEmail', 'signInSocial', 'signInUsername'],
    namespace: /(^|\.)api$/,
    entry: { provider: 'Better Auth', what: 'sign-in' },
  },
  { methods: ['signUpEmail'], namespace: /(^|\.)api$/, entry: { provider: 'Better Auth', what: 'sign-up' } },
  { methods: ['signOut'], namespace: /(^|\.)api$/, entry: { provider: 'Better Auth', what: 'sign-out' } },
  {
    methods: ['forgetPassword'],
    namespace: /(^|\.)api$/,
    entry: { provider: 'Better Auth', what: 'password reset' },
  },
];

/**
 * The same table keyed by the method name, because this is asked of every call in every
 * file of any repository that installed an auth library. A miss has to cost one map
 * lookup, not one regular expression per row.
 */
const ENTRY_BY_METHOD = new Map<string, { namespace: RegExp; entry: AuthEntryPoint }[]>();
for (const { methods, namespace, entry } of AUTH_ENTRY_CALLS) {
  for (const method of methods) {
    const rows = ENTRY_BY_METHOD.get(method);
    if (rows) rows.push({ namespace, entry });
    else ENTRY_BY_METHOD.set(method, [{ namespace, entry }]);
  }
}

/**
 * Names that are an entry point only when the name itself came out of an auth package.
 *
 * NextAuth's and Clerk's are ordinary imported functions — `signIn('github')` — and a
 * bare `signIn` is somebody's own helper far more often than it is a library's. So the
 * import is the evidence here and the name is only the label, which is why this table
 * is never consulted without a resolved package behind it.
 */
const AUTH_ENTRY_NAMES: Record<string, SignInKind> = {
  signIn: 'sign-in',
  signUp: 'sign-up',
  signOut: 'sign-out',
};

/**
 * A privileged namespace, in every library that has one: `supabase.auth.admin.signOut`
 * signs *somebody else* out and needs a service key to do it. A door that reaches for
 * one of these is the last door in a repository that should stop being reported, so the
 * shape of the call disqualifies it whatever the method is called.
 */
const PRIVILEGED_SEGMENT = /(^|\.)admin\./;

/**
 * The auth entry point a call names, or `null` when the call is not one.
 *
 * `rootProvider` is whichever auth package the start of the call was traced back to,
 * and `null` when it could not be traced — most of the time, because apps wrap their
 * client. The caller still has to check the returned provider against what the project
 * actually depends on; naming a library is not the same as using one.
 */
export function authEntryForCall(dotted: string, rootProvider: string | null): AuthEntryPoint | null {
  const dot = dotted.lastIndexOf('.');
  const method = dot === -1 ? dotted : dotted.slice(dot + 1);

  const imported = rootProvider ? AUTH_ENTRY_NAMES[method] : undefined;
  const rows = ENTRY_BY_METHOD.get(method);
  if (!imported && !rows) return null;

  if (PRIVILEGED_SEGMENT.test(dotted)) return null;
  if (imported && rootProvider) return { provider: rootProvider, what: imported };

  const receiver = dot === -1 ? '' : dotted.slice(0, dot);
  for (const row of rows ?? []) {
    if (row.namespace.test(receiver)) return row.entry;
  }
  return null;
}

export function serviceForPackage(pkg: string): ServiceDef | null {
  if (IN_PROCESS_AUTH.has(pkg)) return null;
  return PACKAGE_SERVICES[pkg] ?? null;
}

/**
 * Every company this tool knows how to recognise, by the name it would print.
 *
 * Used to check generated prose against the structure it sits beside: if a paragraph
 * names Stripe and no detector found Stripe, one of the two layers is wrong and the
 * reader is looking at both at once.
 */
export function knownServiceNames(): string[] {
  const names = new Set<string>();
  for (const def of Object.values(PACKAGE_SERVICES)) names.add(def.name);
  for (const def of Object.values(PYTHON_SERVICES)) names.add(def.name);
  for (const { def } of HOST_SERVICES) names.add(def.name);
  return [...names].sort();
}

export function serviceForHost(host: string): ServiceDef | null {
  const lower = host.toLowerCase();
  for (const { pattern, def } of HOST_SERVICES) {
    if (pattern.test(lower)) return def;
  }
  return null;
}

export function storeForPackage(pkg: string): StoreDef | null {
  return STORE_CLIENTS[pkg] ?? null;
}

/** The top-level import name, so `sqlalchemy.orm` is still SQLAlchemy. */
export function serviceForPythonModule(module: string): ServiceDef | null {
  return PYTHON_SERVICES[module.split('.')[0]] ?? null;
}

export function storeForPythonModule(module: string): StoreDef | null {
  return PYTHON_STORES[module.split('.')[0]] ?? null;
}

/** URL scheme → the engine it names, for a connection string we can actually read. */
const URL_ENGINES: Record<string, string> = {
  postgresql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  psycopg: 'PostgreSQL',
  cockroachdb: 'CockroachDB',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  sqlite: 'SQLite',
  mssql: 'SQL Server',
  oracle: 'Oracle',
  snowflake: 'Snowflake',
  duckdb: 'DuckDB',
  bigquery: 'BigQuery',
  clickhouse: 'ClickHouse',
  redshift: 'Redshift',
};

/**
 * `create_engine("postgresql+psycopg://…")` — the engine, read from the URL.
 *
 * SQLAlchemy is the same library whichever database is behind it, so the import says
 * only "a database". The connection string is the one place the answer is written
 * down, and it is written down in a form every dialect agrees on.
 */
export function engineForDatabaseUrl(url: string): string | null {
  const scheme = /^([a-z][a-z0-9]*)(\+[a-z0-9_]+)?:/i.exec(url.trim());
  return scheme ? (URL_ENGINES[scheme[1].toLowerCase()] ?? null) : null;
}

export function authProviderForPackage(pkg: string): string | null {
  for (const { prefix, name } of AUTH_PROVIDERS) {
    if (pkg === prefix || pkg.startsWith(prefix)) return name;
  }
  return null;
}

/** Turns a Prisma `provider` into the engine's usual name. */
export function prismaProviderName(provider: string): string {
  switch (provider) {
    case 'postgresql':
    case 'postgres':
      return 'PostgreSQL';
    case 'mysql':
      return 'MySQL';
    case 'sqlite':
      return 'SQLite';
    case 'sqlserver':
      return 'SQL Server';
    case 'mongodb':
      return 'MongoDB';
    case 'cockroachdb':
      return 'CockroachDB';
    default:
      return 'Database';
  }
}

/**
 * Hostnames that are the app talking to itself. Calls to these are not a data flow
 * out of the app, and putting "localhost" in a list of companies you share data with
 * would be actively misleading.
 */
export function isInternalHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host)
  );
}
