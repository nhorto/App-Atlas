// Everything the server leans on, so the fixture is about registration scope and not
// about missing names.
class AuthenticationError extends Error {}

const db = {
  items: () => [],
  keys: () => [],
  settings: () => ({}),
  lists: async (_listId, _accountId) => [],
};

const collect = () => ({});

const onSubscribe = (fn) => fn;

function requireAdmin(req) {
  if (!req.headers['x-admin']) throw new AuthenticationError('admins only');
}

module.exports = { AuthenticationError, db, collect, onSubscribe, requireAdmin };
