// A real refusal, in its own file so nothing about scope sharing is in play.
function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).end();
  }
  next();
}

module.exports = { requireAdmin };
