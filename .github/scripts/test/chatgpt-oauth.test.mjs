import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { ChatGPTSession } from '../../ci-oauth/worker.mjs';

const URL = 'https://example.com/v1/chatgpt-access';
const KEY = 'fixture-access-key';
const request = (token) => new Request(URL, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

function storage(seed) {
  const values = new Map(seed ? [['oauth', seed]] : []);
  return { get: async (key) => values.get(key), put: async (key, value) => values.set(key, value) };
}

test('the authorized endpoint exposes only the temporary access grant', async () => {
  const state = storage();
  const seed = { clientID: 'public-id', access: 'fixture-bearer', refresh: 'fixture-renewal',
    expiresAt: Date.now() + 3600_000 };
  const object = new ChatGPTSession({ storage: state }, { OPENAI_OAUTH_SEED: JSON.stringify(seed) });
  const env = { CI_ACCESS_KEY: KEY, SESSION: { idFromName: (name) => name, get: () => object } };
  assert.equal((await worker.fetch(request('wrong'), env)).status, 401);
  assert.equal((await worker.fetch(new Request(URL), env)).status, 405);
  assert.equal(await state.get('oauth'), undefined);
  const grant = await worker.fetch(request(KEY), env);
  assert.deepEqual(await grant.json(), { access_token: 'fixture-bearer' });
  assert.equal(grant.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await state.get('oauth'), seed);
});

test('parallel jobs share one refresh and the replacement survives a restart', async (t) => {
  const state = storage({ clientID: 'public-id', access: 'old', refresh: 'old-refresh', expiresAt: 0 });
  const renew = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/token');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    const fields = new URLSearchParams(options.body);
    assert.equal(fields.get('grant_type'), 'refresh_token');
    assert.equal(fields.get('refresh_token'), 'old-refresh');
    assert.equal(fields.get('client_id'), 'public-id');
    assert.equal(fields.get('resource'), 'https://api.openai.com/v1');
    return Response.json({ access_token: 'renewed', refresh_token: 'new-refresh', expires_in: 3600 });
  });
  const first = new ChatGPTSession({ storage: state }, {});
  const calls = await Promise.all([first.fetch(), first.fetch(), first.fetch()]);
  for (const call of calls) assert.deepEqual(await call.json(), { access_token: 'renewed' });
  const restarted = new ChatGPTSession({ storage: state }, {});
  assert.deepEqual(await (await restarted.fetch()).json(), { access_token: 'renewed' });
  assert.equal(renew.mock.callCount(), 1);
  assert.equal((await state.get('oauth')).refresh, 'new-refresh');
});

test('a temporary exchange failure preserves the current grant only while it is valid', async (t) => {
  const session = { clientID: 'public-id', access: 'current', refresh: 'current-refresh',
    expiresAt: Date.now() + 60_000 };
  const state = storage(session);
  const renew = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('private fixture detail');
  });
  const object = new ChatGPTSession({ storage: state }, {});
  const current = await object.fetch();
  assert.equal(current.headers.get('X-ChatGPT-OAuth-Status'), 'exchange_transport');
  assert.deepEqual(await current.json(), { access_token: 'current' });
  assert.deepEqual(await (await object.fetch()).json(), { access_token: 'current' });
  assert.equal(renew.mock.callCount(), 1);
  await state.put('oauth', { ...session, expiresAt: 0 });
  const expired = await object.fetch();
  assert.equal(expired.status, 503);
  assert.equal(expired.headers.get('X-ChatGPT-OAuth-Status'), 'exchange_transport');
  assert.deepEqual(await expired.json(), { error: 'chatgpt_authorization_unavailable' });
});
