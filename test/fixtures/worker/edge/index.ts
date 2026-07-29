/** The edge API: one script answers every path on the domain. */
export default {
  async fetch(request: Request): Promise<Response> {
    return new Response(`hello from ${new URL(request.url).pathname}`);
  },
};
