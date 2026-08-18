import EmberRouter from '@ember/routing/router';

export default class Router extends EmberRouter {
  location = 'history';
}

Router.map(function () {
  this.route('posts', function () {
    this.route('edit', { path: '/:post_id/edit' });
  });
});
