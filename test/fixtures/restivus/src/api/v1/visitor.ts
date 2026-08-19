import { API } from '../index';

// The two-argument form: no options at all, handlers second.
API.v1.addRoute('livechat/visitor.status', {
  async post() {
    return { token: 'x', status: 'online' };
  },
});

// Said in as many words to be open.
API.v1.addRoute(
  'livechat/config',
  { authRequired: false },
  {
    async get() {
      return { config: {} };
    },
  },
);
