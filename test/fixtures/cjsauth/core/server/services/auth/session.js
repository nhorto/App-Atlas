// A middleware factory: the guard is what this returns, not this.
function createSessionFromToken() {
  return function sessionFromToken(req, res, next) {
    if (!req.headers.authorization) return res.status(401).end();
    return next();
  };
}

module.exports = { createSessionFromToken };
