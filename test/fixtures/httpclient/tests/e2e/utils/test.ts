// The client, near enough verbatim from `apps/meteor/tests/e2e/utils/test.ts`.
//
// Every method takes a *uri* and prepends a prefix before it goes anywhere. So the string
// written at the call site is half an address, and the half that is missing is in this
// file rather than that one.
import { API_PREFIX } from '../config/constants';

interface RequestContext {
  get(url: string, opts?: unknown): Promise<unknown>;
  post(url: string, opts?: unknown): Promise<unknown>;
  delete(url: string, opts?: unknown): Promise<unknown>;
}

export function makeApi(apiContext: RequestContext) {
  return {
    get(uri: string, params?: unknown, prefix = API_PREFIX) {
      return apiContext.get(prefix + uri, { params });
    },
    post(uri: string, data: unknown, prefix = API_PREFIX) {
      return apiContext.post(prefix + uri, { data });
    },
    delete(uri: string, params?: unknown, prefix = API_PREFIX) {
      return apiContext.delete(prefix + uri, { params });
    },
  };
}
