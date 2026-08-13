function requireAuth(req, res, next) {
  if (!req.headers.authorization) return res.status(401).send('sign in first');
  next();
}

module.exports = { requireAuth };
