/*
  POST /api/stripe/integration/webhook/test — listen to Stripe test mode connect webhooks.

  The door this whole rule is built around, copied from dub, where it is still live at
  `apps/web/app/(ee)/api/stripe/integration/webhook/test/route.ts`. Stripe delivers test
  mode events for a connected account to a *separate* endpoint from live ones, so the
  word "test" here is Stripe's, and the URL is one a stranger on the internet can post
  to. A path is never allowed to take this door off the map.
*/
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  return Response.json({ received: body.length });
}
