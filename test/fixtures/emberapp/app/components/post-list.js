import Component from '@glimmer/component';

export default class PostList extends Component {
  get sorted() {
    return [...this.args.posts].sort((a, b) => b.publishedAt - a.publishedAt);
  }
}
