import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const queryString = require('query-string');
test('navigation query decoder preserves Turkish characters and repeated values', () => {
  const parsed = queryString.parse('park=Yo%C4%9Furt%C3%A7u&etiket=mama&etiket=su');
  assert.equal(parsed.park, 'Yoğurtçu');
  assert.deepEqual(parsed.etiket, ['mama', 'su']);
});
test(
  'malformed percent-encoded input terminates and does not crash navigation',
  { timeout: 2000 },
  () => {
    const parsed = queryString.parse('note=' + '%FE%FF%80'.repeat(1000));
    assert.equal(typeof parsed.note, 'string');
  },
);
test('patched UUID remains compatible with Xcode project generation', () => {
  const project = require('xcode').project('test.pbxproj');
  project.hash = { project: { objects: {} } };
  assert.match(project.generateUuid(), /^[0-9A-F]{24}$/);
});
