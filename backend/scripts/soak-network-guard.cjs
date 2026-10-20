// Test-only preload: preserve every production feed identity while routing all
// external HTTP to one local fixture. Never used by npm start.
const nativeFetch = globalThis.fetch;
require('../tests/testSetup.cjs');
globalThis.fetch = (url, options) => {
  const target = new URL(url instanceof Request ? url.url : String(url));
  if (['127.0.0.1', 'localhost', '[::1]', '::1'].includes(target.hostname)) return nativeFetch(url, options);
  const base = process.env.OGID_SOAK_FEED_BASE;
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw Error('SOAK_FIXTURE_REQUIRED');
  return nativeFetch(`${base}/${encodeURIComponent(target.href)}`, options);
};
