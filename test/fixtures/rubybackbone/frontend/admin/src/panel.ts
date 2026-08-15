// A second package, because one package in a workspace is not a workspace (`scopes.length
// < 2` returns nothing) and the defect only exists on the listing that a switcher prints.
export function renderPanel(): string {
  return 'admin';
}
