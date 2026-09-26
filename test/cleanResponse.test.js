const test = require('node:test');
const assert = require('node:assert/strict');

const { stripNullish } = require('../server/lib/cleanResponse');

test('stripNullish removes null and undefined values, keeping everything else', () => {
  assert.deepEqual(
    stripNullish({ a: 1, b: null, c: undefined, d: 0, e: false, f: '', g: 'x' }),
    { a: 1, d: 0, e: false, f: '', g: 'x' }
  );
});

test('stripNullish returns an empty object when everything is null/undefined', () => {
  assert.deepEqual(stripNullish({ a: null, b: undefined }), {});
});

test('stripNullish leaves an already-clean object untouched', () => {
  assert.deepEqual(stripNullish({ a: 1, b: 'x' }), { a: 1, b: 'x' });
});

test('stripNullish passes through non-object input unchanged', () => {
  assert.equal(stripNullish(null), null);
  assert.equal(stripNullish(undefined), undefined);
  assert.equal(stripNullish('x'), 'x');
});
