// Named after what it guards, which is what real applications do. Ghost declares 218 of
// its 261 admin routes with `mw.authAdminApi`, and an exact-match list of guard names
// sees none of them.
const auth = require('../../services/auth/session');

module.exports.authAdminApi = [auth.createSessionFromToken()];

// The trap, and the reason the rule anchors on a word boundary. This is a blogging
// platform: `authorList` is a list of authors, not a check on anybody. Ghost has
// `authorExists`, `authorImage` and `authorFacebook` for the same reason.
module.exports.authorList = function authorList(req, res, next) {
  res.locals.authors = [];
  return next();
};
