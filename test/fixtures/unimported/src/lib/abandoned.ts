/**
 * @fileoverview A first attempt at parsing the feed, left behind when the second one
 * worked. Nothing in the app imports it — which is the whole point of this fixture.
 */
export function oldParser(input: string): string[] {
  return input.split(',');
}

export interface OldShape {
  raw: string;
}
