/**
 * Not every `addRoute` registers an HTTP endpoint. vue-router's takes the same two
 * shapes — a record on its own, or a parent name and a child record — and what it
 * registers is a screen. A trie takes a path and a payload.
 */
import { Router } from 'vue-router';

declare const router: Router;
declare const AdminUsers: unknown;

router.addRoute('admin', { path: 'users', name: 'admin-users', component: AdminUsers });

const trie = {
  addRoute(path: string, payload: Record<string, unknown>) {
    void path;
    void payload;
  },
};

trie.addRoute('/users/:id', { handler: 'usersShow', priority: 2 });
