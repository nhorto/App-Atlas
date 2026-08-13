// The call sites, in a subclass and a different file — exactly where parse-server keeps
// them. The path is a tail: nothing here says where this router is mounted.
const { PromiseRouter } = require('../PromiseRouter');

class UsersRouter extends PromiseRouter {
  mountRoutes() {
    this.route('GET', '/users', req => this.handleFind(req));
    this.route('POST', '/users', req => this.handleCreate(req));
    this.route('GET', '/users/me', req => this.handleMe(req));
    this.route('DELETE', '/users/:objectId', req => this.handleDelete(req));
    this.route('POST', '/login', req => this.handleLogIn(req));
    // An address this repository computes and does not write down. Parse Server has
    // seven of these, all `/${this.pagesEndpoint}/…`, and the honest answer is nothing.
    this.route('GET', `/${this.prefix}/verify_email`, req => this.handleVerify(req));
  }
}

module.exports = { UsersRouter };
