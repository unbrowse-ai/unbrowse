// Runs the built node (dist/) against a mocked n8n context.
// Mocked by default; UNBROWSE_LIVE=1 with UNBROWSE_API_KEY set calls the hosted API.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { Unbrowse } = require('../dist/nodes/Unbrowse/Unbrowse.node.js');
const { UnbrowseApi } = require('../dist/credentials/UnbrowseApi.credentials.js');

const LIVE = process.env.UNBROWSE_LIVE === '1' && Boolean(process.env.UNBROWSE_API_KEY);
const KEY = process.env.UNBROWSE_API_KEY ?? '';

function bearer(apiKey) {
	const credential = new UnbrowseApi();
	const template = credential.authenticate.properties.headers.Authorization;
	return template.replace('={{$credentials.apiKey}}', apiKey).replace(/^=/, '').replace('{{$credentials.apiKey}}', apiKey);
}

async function liveRequest(apiKey, options) {
	const response = await fetch(options.url, {
		method: options.method,
		headers: { ...options.headers, Authorization: bearer(apiKey) },
		body: JSON.stringify(options.body),
	});
	const body = await response.json();
	if (!response.ok) {
		const error = new Error(`HTTP ${response.status}`);
		error.httpCode = String(response.status);
		error.response = { status: response.status, data: body };
		throw error;
	}
	return body;
}

function context(params, { reply, apiKey = 'ub_live_test', continueOnFail = false } = {}) {
	const sent = [];
	return {
		sent,
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getNode: () => ({ id: '1', name: 'Unbrowse', type: 'n8n-nodes-unbrowse.unbrowse', typeVersion: 1, position: [0, 0], parameters: {} }),
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequestWithAuthentication: async (credentialType, options) => {
				assert.equal(credentialType, 'unbrowseApi');
				sent.push(options);
				return reply ? reply(options) : liveRequest(apiKey, options);
			},
		},
	};
}

const textResult = (payload) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });

test('credential tests the key with a tools/list POST', () => {
	const credential = new UnbrowseApi();
	assert.equal(credential.name, 'unbrowseApi');
	assert.equal(credential.test.request.method, 'POST');
	assert.equal(credential.test.request.baseURL + credential.test.request.url, 'https://unbrowse.ai/api/mcp');
	assert.equal(credential.test.request.body.method, 'tools/list');
	assert.equal(bearer('ub_live_x'), 'Bearer ub_live_x');
});

test('Scrape Page sends unbrowse.scrape and returns the decoded page', async () => {
	const page = { url: 'https://example.com', metadata: { title: 'Example Domain' }, markdown: '# Example' };
	const ctx = context({ operation: 'scrapePage', url: 'https://example.com', scrapeOptions: { render: 'never' } }, { reply: () => textResult(page) });
	const [[item]] = await new Unbrowse().execute.call(ctx);
	assert.deepEqual(item.json, page);
	assert.equal(ctx.sent[0].url, 'https://unbrowse.ai/api/mcp');
	assert.deepEqual(ctx.sent[0].body.params, { name: 'unbrowse.scrape', arguments: { url: 'https://example.com', formats: ['markdown'], render: 'never' } });
});

test('Scrape Page rejects a non-http URL', async () => {
	const ctx = context({ operation: 'scrapePage', url: 'file:///etc/passwd' }, { reply: () => assert.fail('no request') });
	await assert.rejects(new Unbrowse().execute.call(ctx), /http/);
});

test('Discover sends the query', async () => {
	const ctx = context({ operation: 'discover', query: 'hacker news' }, { reply: () => textResult({ public: [{ id: 'hn.top_stories' }] }) });
	const [[item]] = await new Unbrowse().execute.call(ctx);
	assert.equal(item.json.public[0].id, 'hn.top_stories');
	assert.deepEqual(ctx.sent[0].body.params, { name: 'unbrowse.discover', arguments: { query: 'hacker news' } });
});

test('Run Task parses JSON input and needs a task or capability', async () => {
	const ctx = context({ operation: 'runTask', task: '', runOptions: { capability: 'hn.top_stories', input: '{"n": 5}' } }, { reply: () => textResult({ status: 'succeeded', result: [] }) });
	const [[item]] = await new Unbrowse().execute.call(ctx);
	assert.equal(item.json.status, 'succeeded');
	assert.deepEqual(ctx.sent[0].body.params.arguments, { capability: 'hn.top_stories', input: { n: 5 } });
	await assert.rejects(new Unbrowse().execute.call(context({ operation: 'runTask', task: '', runOptions: {} }, { reply: () => ({}) })), /task/);
	await assert.rejects(new Unbrowse().execute.call(context({ operation: 'runTask', task: 'x', runOptions: { input: '[1]' } }, { reply: () => ({}) })), /JSON object/);
});

test('a JSON-RPC error becomes a node error, or an error item with Continue On Fail', async () => {
	const reply = () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } });
	await assert.rejects(new Unbrowse().execute.call(context({ operation: 'discover', query: 'q' }, { reply })), /boom/);
	const [[item]] = await new Unbrowse().execute.call(context({ operation: 'discover', query: 'q' }, { reply, continueOnFail: true }));
	assert.match(item.json.error, /boom/);
});

test('live: credential test accepts the key and rejects a bad one', { skip: !LIVE }, async () => {
	const { request } = new UnbrowseApi().test;
	const options = { ...request, url: request.baseURL + request.url };
	const ok = await liveRequest(KEY, options);
	assert.ok(ok.result.tools.some((tool) => tool.name === 'unbrowse.scrape'));
	await assert.rejects(liveRequest('ub_live_invalid', options), /HTTP 401/);
});

test('live: Scrape Page', { skip: !LIVE }, async () => {
	const ctx = context({ operation: 'scrapePage', url: 'https://example.com', scrapeOptions: { render: 'never', formats: ['markdown', 'links'] } }, { apiKey: KEY });
	const [[item]] = await new Unbrowse().execute.call(ctx);
	assert.equal(item.json.metadata.title, 'Example Domain');
	assert.match(item.json.markdown, /Example Domain/);
});

test('live: Discover', { skip: !LIVE }, async () => {
	const [[item]] = await new Unbrowse().execute.call(context({ operation: 'discover', query: 'hacker news top stories' }, { apiKey: KEY }));
	assert.equal(typeof item.json, 'object');
});

test('live: Run Task', { skip: !LIVE }, async () => {
	const [[item]] = await new Unbrowse().execute.call(context({ operation: 'runTask', task: 'get the top stories on hacker news', runOptions: {} }, { apiKey: KEY }));
	assert.ok(['succeeded', 'input_required', 'no_capability'].includes(item.json.status), JSON.stringify(item.json).slice(0, 300));
});
