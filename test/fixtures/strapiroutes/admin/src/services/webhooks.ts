// The React admin's *outbound* requests, in the shape
// `packages/core/admin/admin/src/services/webhooks.ts` uses. Same file tree, same
// `method: 'GET'`, and not a door — nothing on the browser side answers a request.
//
// Two things keep these out, and the fixture exists to prove both still do: the address
// is keyed `url` rather than `path`, and there is no `handler`.
export const webhooksApi = adminApi.injectEndpoints({
  endpoints: (builder: any) => ({
    getWebhooks: builder.query({
      query: (args: { id?: string }) => ({
        url: `/admin/webhooks/${args?.id ?? ''}`,
        method: 'GET',
      }),
    }),
    createWebhook: builder.mutation({
      query: (body: unknown) => ({
        url: '/admin/webhooks',
        method: 'POST',
        data: body,
      }),
    }),
  }),
});

declare const adminApi: { injectEndpoints: (config: unknown) => any };
