// outline's shape, and a second client library (#236). `server` here is supertest bound
// to the app under test, not the app — so these are requests, and the 41 doors outline
// reported from files like this one were all requests.
//
// The query string is the tell a reader would use: no router anywhere registers a route
// at `/api/cron.daily?token=token`. It is not what this rule reads, because the missing
// handler already answers the question and one fact is enough — but it is why the
// addresses looked wrong to a person long before the rule did.
import request from 'supertest';

import { app } from '../src/server';

const server = request(app);

export async function run() {
  await server.get('/api/cron.daily');
  await server.get('/api/cron.daily?token=token');
  await server.post('/api/utils.gc');
  await server.get('/.well-known/oauth-protected-resource');
}
