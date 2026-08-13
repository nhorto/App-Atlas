// Strapi's shape: `services/mcp/__tests__/` holds a mock route array, and the six doors
// it declares were most of what `packages/core/core` appeared to serve. The filename says
// nothing — no `.test.`, no `.spec.` — so the directory is carrying the whole claim.
import express from 'express';

const mock = express();

mock.post('/mcp/tools/call', (_req, res) => res.json({ result: null }));

export { mock };
