// Strapi's admin route data, in the shape `packages/core/upload/server/src/routes/admin.ts`
// uses. Note there are no imports at all: seven doors and not one line naming the
// framework, which is why the detector is gated on the package rather than the file.
export const routes = {
  type: 'admin',
  routes: [
    {
      method: 'GET',
      path: '/settings',
      handler: 'admin-settings.getSettings',
      config: {
        policies: [
          'admin::isAuthenticatedAdmin',
          {
            name: 'admin::hasPermissions',
            config: { actions: ['plugin::upload.settings.read'] },
          },
        ],
      },
    },
    {
      method: 'PUT',
      path: '/settings',
      handler: 'admin-settings.updateSettings',
      config: {
        policies: ['admin::isAuthenticatedAdmin'],
      },
    },
    // No `config` at all. Strapi's content API authorizes these through a scope generated
    // at boot from the handler name, which is not in this file — so the honest answer is
    // that nothing here was examined.
    {
      method: 'GET',
      path: '/files/:id',
      handler: 'admin-file.findOne',
    },
  ],
};
