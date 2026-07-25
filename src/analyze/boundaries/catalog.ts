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
import type { ServiceCategory, StoreKind } from '../../model/types.js';

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
  // auth
  '@clerk/nextjs': { name: 'Clerk', category: 'auth' },
  '@clerk/clerk-sdk-node': { name: 'Clerk', category: 'auth' },
  '@clerk/backend': { name: 'Clerk', category: 'auth' },
  'next-auth': { name: 'NextAuth', category: 'auth' },
  '@auth/core': { name: 'Auth.js', category: 'auth' },
  '@auth0/nextjs-auth0': { name: 'Auth0', category: 'auth' },
  'auth0': { name: 'Auth0', category: 'auth' },
  'better-auth': { name: 'Better Auth', category: 'auth' },
  lucia: { name: 'Lucia', category: 'auth' },
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

export function serviceForPackage(pkg: string): ServiceDef | null {
  return PACKAGE_SERVICES[pkg] ?? null;
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
