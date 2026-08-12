export default {
  async fetch(): Promise<Response> {
    return new Response('a sample worker');
  },
};
