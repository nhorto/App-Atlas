import { Hono } from 'hono';

const app = new Hono();

/** The app's own door. Nothing in `examples/` is allowed to add to or subtract from it. */
app.get('/health', (c) => c.json({ ok: true }));

export default app;
