import { API } from '../index';

// The typed spelling: the verb is the method, the options sit in the middle, and the
// action is handed over last.
API.v1.get(
  'licenses.info',
  { authRequired: true, permissionsRequired: ['view-privileged-setting'] },
  async function action() {
    return { license: {} };
  },
);

API.v1.post('licenses.add', { authRequired: true, twoFactorRequired: true }, async function action() {
  return { success: true };
});

// Per-verb permissions: what is required of a POST is not a check on the GET that shares
// the address.
API.v1.get(
  'channels.list',
  { authRequired: true, permissionsRequired: { GET: { operation: 'hasAll', permissions: ['view-c-room'] } } },
  async function action() {
    return { channels: [] };
  },
);

// The verbs return the API object, so registrations chain. Eleven doors hang off one
// `API.v1` in Rocket.Chat's `ee/server/api/abac/index.ts`.
API.v1
  .get('abac/attributes', { authRequired: true, permissionsRequired: ['abac-management'] }, async function action() {
    return { attributes: [] };
  })
  .delete('abac/attributes/:_id', { authRequired: true }, async function action() {
    return { success: true };
  });
