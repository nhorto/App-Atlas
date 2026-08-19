import { API } from '../index';

API.v1.addRoute(
  'canned-responses.get',
  { authRequired: true, permissionsRequired: ['view-canned-responses'], license: ['canned-responses'] },
  {
    async get() {
      return { responses: [] };
    },
  },
);

// Two verbs on one registration are two doors, and only one of them writes.
API.v1.addRoute(
  'canned-responses',
  { authRequired: true, permissionsRequired: ['save-canned-responses'] },
  {
    async get() {
      return { cannedResponses: [] };
    },
    async post() {
      return { success: true };
    },
    async delete() {
      return { success: true };
    },
  },
);
