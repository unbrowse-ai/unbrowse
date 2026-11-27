// Issue short-lived OpenCode access grants to GitHub Actions. Only this storage object holds the renewable session.
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const PATH = '/v1/chatgpt-access';
const MIN_LIFETIME = 20 * 60 * 1000;
const encoder = new TextEncoder();

function reply(body, status = 200, detail) {
  const headers = { 'Cache-Control': 'no-store' };
  if (detail) headers['X-ChatGPT-OAuth-Status'] = detail;
  return Response.json(body, { status, headers });
}

class RenewalError extends Error {
  constructor(detail) {
    super('ChatGPT OAuth renewal failed');
    this.detail = detail;
  }
}

async function matches(supplied, expected) {
  if (!expected || !supplied) return false;
  const [left, right] = await Promise.all([supplied, `Bearer ${expected}`].map(async (value) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))));
  return left.reduce((difference, byte, index) => difference | (byte ^ right[index]), 0) === 0;
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== PATH) return reply({ error: 'not_found' }, 404);
    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
    if (!await matches(request.headers.get('Authorization'), env.CI_ACCESS_KEY)) {
      return reply({ error: 'unauthorized' }, 401);
    }
    return env.SESSION.get(env.SESSION.idFromName('unbrowse-ci')).fetch(`https://oauth-state.invalid${PATH}`, {
      method: 'POST',
    });
  },
};

export class ChatGPTSession {
  constructor(ctx, env) {
    this.storage = ctx.storage;
    this.seed = env.OPENAI_OAUTH_SEED;
    this.pending = null;
    this.retryAfter = 0;
    this.renewalStatus = undefined;
  }

  async fetch() {
    // All concurrent callers share one exchange for this rotating OAuth session.
    this.pending ??= this.access().finally(() => { this.pending = null; });
    try {
      const accessToken = await this.pending;
      return reply({ access_token: accessToken }, 200, this.renewalStatus);
    } catch (error) {
      return reply({ error: 'chatgpt_authorization_unavailable' }, 503, this.renewalStatus);
    }
  }

  async access() {
    let session = await this.storage.get('oauth');
    if (this.seed) {
      const seed = JSON.parse(this.seed);
      if (!session || (seed.generation && seed.generation !== session.generation)) {
        session = seed;
        await this.storage.put('oauth', session);
      }
    }
    if (!session?.access || !session.refresh || !session.clientID) throw new Error('missing OAuth seed');
    if (session.expiresAt - Date.now() >= MIN_LIFETIME) return session.access;

    if (Date.now() < this.retryAfter && session.expiresAt > Date.now()) return session.access;
    try {
      session = await this.renew(session);
      this.renewalStatus = undefined;
    } catch (error) {
      this.renewalStatus = error.detail ?? 'exchange_unavailable';
      if (session.expiresAt <= Date.now()) throw error;
      this.retryAfter = Math.min(session.expiresAt, Date.now() + 60_000);
    }
    return session.access;
  }

  async renew(session) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response;
    let next;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: session.clientID,
          refresh_token: session.refresh,
          resource: 'https://api.openai.com/v1',
        }).toString(),
        signal: controller.signal,
      });
      next = await response.json().catch(() => null);
    } catch {
      throw new RenewalError(controller.signal.aborted ? 'exchange_timeout' : 'exchange_transport');
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const code = next?.error?.code ?? next?.error;
      const safe = ['invalid_grant', 'invalid_client', 'invalid_refresh_token', 'refresh_token_reused',
        'refresh_token_invalidated', 'token_expired', 'refresh_token_expired', 'refresh_too_early',
        'too_early_to_refresh', 'temporarily_unavailable'];
      throw new RenewalError(`exchange_${response.status}${safe.includes(code) ? `_${code}` : ''}`);
    }
    if (typeof next?.access_token !== 'string' || typeof next.refresh_token !== 'string') {
      throw new RenewalError('exchange_incomplete');
    }
    const lifetime = Number(next.expires_in);
    const rotated = { ...session, access: next.access_token, refresh: next.refresh_token,
      expiresAt: Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600) * 1000 };
    try {
      await this.storage.put('oauth', rotated);
    } catch {
      throw new RenewalError('exchange_storage');
    }
    return rotated;
  }
}
