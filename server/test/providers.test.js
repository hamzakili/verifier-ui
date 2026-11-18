import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createProviderRegistry } from '../src/providers/registry.js';

test('default provider is MillionVerifier when unset or invalid', () => {
  assert.equal(loadConfig({}).defaultProvider, 'millionverifier');
  const bad = loadConfig({ DEFAULT_VERIFICATION_PROVIDER: 'zerobounce' });
  assert.equal(bad.defaultProvider, 'millionverifier');
  assert.ok(bad.warnings.some((w) => w.includes('not supported')));
  assert.equal(loadConfig({ DEFAULT_VERIFICATION_PROVIDER: 'NeverBounce' }).defaultProvider, 'neverbounce');
});

test('startup validation flags a bad API URL', () => {
  const c = loadConfig({ MILLIONVERIFIER_API_URL: 'http://insecure.example.com' });
  assert.equal(c.providers.millionverifier.apiUrl, 'https://api.millionverifier.com/api/v3/');
  assert.ok(c.warnings.some((w) => w.includes('MILLIONVERIFIER_API_URL')));
});

test('registry: list, switch, reject invalid and unconfigured providers', () => {
  const reg = createProviderRegistry(loadConfig({ MILLIONVERIFIER_API_KEY: 'mvkey1234', NEVERBOUNCE_API_KEY: 'private_abcd' }));
  assert.equal(reg.getActive(), 'millionverifier');
  assert.deepEqual(
    reg.list().map((p) => [p.id, p.available, p.is_active]),
    [['millionverifier', true, true], ['neverbounce', true, false]],
  );

  assert.equal(reg.setActive('neverbounce'), 'neverbounce');
  assert.equal(reg.getActive(), 'neverbounce');
  assert.equal(reg.setActive('millionverifier'), 'millionverifier');

  assert.throws(() => reg.setActive('mailgun'), (e) => e.status === 400 && e.code === 'unsupported_provider');
  assert.throws(() => reg.setActive(''), (e) => e.status === 400);

  const partial = createProviderRegistry(loadConfig({ MILLIONVERIFIER_API_KEY: 'mvkey1234' }));
  assert.throws(() => partial.setActive('neverbounce'), (e) => e.status === 409 && e.code === 'provider_not_configured');
  assert.equal(partial.getActive(), 'millionverifier');
});

test('registry never exposes keys', () => {
  const reg = createProviderRegistry(loadConfig({ MILLIONVERIFIER_API_KEY: 'SECRETMV9k2T', NEVERBOUNCE_API_KEY: 'private_secretnb' }));
  const json = JSON.stringify(reg.list());
  assert.ok(!json.includes('SECRETMV'));
  assert.ok(!json.includes('secretnb'));
  assert.equal(reg.keyHint('millionverifier'), '••••9k2T');
  assert.equal(reg.keyHint('neverbounce'), 'private_••••etnb');
});
