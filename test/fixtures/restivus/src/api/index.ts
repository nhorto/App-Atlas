/**
 * The API object every registration hangs off. Its address is assembled at runtime from
 * two fields and a mount that lives somewhere else, which is the whole reason the doors
 * below can only be half-read.
 */
class APIClass {
  private readonly apiPath: string;

  constructor({ apiPath, version }: { apiPath: string; version?: string }) {
    this.apiPath = [apiPath, version].filter(Boolean).join('/').replaceAll('//', '/');
  }

  addRoute(subpath: string, options: unknown, endpoints?: unknown): void {
    void `/${this.apiPath}/${subpath}`;
    void options;
    void endpoints;
  }
}

export const API = {
  v1: new APIClass({ apiPath: '', version: 'v1' }),
};
