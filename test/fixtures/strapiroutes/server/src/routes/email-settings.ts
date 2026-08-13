// A second `/settings`, because in the real repo that tail appears **seven times** across
// unrelated plugins — email, upload, users-permissions — and each is served under its own
// plugin prefix. With the head unread they are seven doors sharing one name and nothing
// else, so if the key were the tail they would merge and this one's policy would land on
// all of them.
export const routes = {
  type: 'admin',
  routes: [
    {
      method: 'GET',
      path: '/settings',
      handler: 'email-settings.getSettings',
      config: {
        policies: ['admin::isAuthenticatedAdmin', 'plugin::email.settings.read'],
      },
    },
  ],
};
