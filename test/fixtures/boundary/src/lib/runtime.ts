/** Config that whatever is running the app supplies, plus one that it does not.
 *
 * `NODE_ENV` and `VERCEL_URL` are set by the runtime and the host. Nobody writes them
 * into `.env.example`, so counting them as "missing" turns a list that means "you
 * forgot to write this down" into a list the reader learns to skip — on taxonomy,
 * `NODE_ENV` was the *only* row in that section.
 *
 * `GITHUB_CLIENT_SECRET` wears a prefix that belongs to a real platform family — CI
 * injects a dozen `GITHUB_*` variables — and is nonetheless this app's own OAuth
 * credential. Excusing it would be the same mistake in the direction that costs. */
export const runtime = {
  env: process.env.NODE_ENV,
  host: process.env.VERCEL_URL,
  oauthSecret: process.env.GITHUB_CLIENT_SECRET,
};
