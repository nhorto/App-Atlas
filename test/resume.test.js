/**
 * @fileoverview Keeping a reader's place in a walkthrough across a reload (#212).
 *
 * Imported from `web/src/` as source, for the reason `mapview.test.js` gives: the web
 * build is a bundle rather than a module anybody can import, and these are rules rather
 * than pixels.
 *
 * Everything here is about failing closed. The stored value outlives the atlas that
 * produced it — the project gets re-analyzed, tours are recomputed from it, and a step
 * that existed this morning may not exist now. Every way of reading something that is
 * not a place in this atlas has to come back as "no place", because the alternative is
 * putting somebody back into a walkthrough at a step they were never on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

/** Node has no `localStorage`, and the browser's throws in more cases than people expect. */
function fakeStorage({ throwOn } = {}) {
  const values = new Map();
  return {
    values,
    getItem(key) {
      if (throwOn === 'get') throw new Error('storage is disabled');
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (throwOn === 'set') throw new Error('quota exceeded');
      values.set(key, String(value));
    },
    removeItem(key) {
      if (throwOn === 'remove') throw new Error('storage is disabled');
      values.delete(key);
    },
  };
}

const install = (storage) => {
  globalThis.localStorage = storage;
  return storage;
};

const { atlasKey, forgetTour, recallTour, rememberTour } = await import('../web/src/resume.ts');

test('a place put down is the place picked up', () => {
  const store = install(fakeStorage());
  const key = atlasKey('/srv/app', '');
  rememberTour(key, { tourId: 'tour:welcome', stepId: 'welcome:in' });
  assert.deepEqual(recallTour(key), { tourId: 'tour:welcome', stepId: 'welcome:in' });
  assert.equal(store.values.size, 1);
});

test('two apps in one workspace do not share a place', () => {
  install(fakeStorage());
  const one = atlasKey('/srv/mono', 'packages/api');
  const two = atlasKey('/srv/mono', 'packages/web');
  rememberTour(one, { tourId: 'tour:welcome', stepId: 'welcome:in' });
  assert.notEqual(one, two);
  assert.equal(recallTour(two), null, 'switching app is closer to opening a different project');
});

test('nothing stored is no place, not an error', () => {
  install(fakeStorage());
  assert.equal(recallTour(atlasKey('/srv/app', '')), null);
});

test('a value that is not a place reads as no place', () => {
  const store = install(fakeStorage());
  const key = atlasKey('/srv/app', '');

  for (const junk of ['not json at all', '{"tourId":"tour:welcome"}', '{"stepId":"welcome:in"}', 'null', '[]', '{"tourId":4,"stepId":9}']) {
    store.values.set(key, junk);
    assert.equal(recallTour(key), null, `${junk} is not a place in an atlas`);
  }
});

test('forgetting is forgetting', () => {
  const store = install(fakeStorage());
  const key = atlasKey('/srv/app', '');
  rememberTour(key, { tourId: 'tour:welcome', stepId: 'welcome:in' });
  forgetTour(key);
  assert.equal(recallTour(key), null);
  assert.equal(store.values.size, 0);
});

test('storage that throws costs the feature and nothing else', () => {
  // A private window, cookies switched off, a full quota. None of it is worth a word on
  // screen: the cost of losing this is one click, and an error about it would be louder
  // than the thing it is apologising for.
  const key = atlasKey('/srv/app', '');

  install(fakeStorage({ throwOn: 'set' }));
  assert.doesNotThrow(() => rememberTour(key, { tourId: 'tour:welcome', stepId: 'welcome:in' }));

  install(fakeStorage({ throwOn: 'get' }));
  assert.equal(recallTour(key), null);

  install(fakeStorage({ throwOn: 'remove' }));
  assert.doesNotThrow(() => forgetTour(key));
});

test('the step is stored by id, so a renumbered tour cannot move somebody', () => {
  // The whole reason the index is not what is written down. A traced tour gains a hop
  // when the code gains one, and step 4 stops being the step somebody was reading.
  install(fakeStorage());
  const key = atlasKey('/srv/app', '');
  rememberTour(key, { tourId: 'tour:endpoint:GET /users', stepId: 'endpoint:GET /users:hop2' });
  const found = recallTour(key);
  assert.equal(found.stepId, 'endpoint:GET /users:hop2');
  assert.ok(!('stepIndex' in found), 'an index would survive a re-analysis while meaning something else');
});
