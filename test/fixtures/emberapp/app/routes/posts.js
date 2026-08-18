import Route from '@ember/routing/route';

export default class PostsRoute extends Route {
  model() {
    return fetch('/ghost/api/admin/posts/').then((r) => r.json());
  }
}
