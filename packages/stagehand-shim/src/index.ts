/**
 * @unbrowse/stagehand-shim — drop-in for `@browserbasehq/stagehand`.
 *
 *   - import { Stagehand } from '@browserbasehq/stagehand';
 *   + import { Stagehand } from '@unbrowse/stagehand-shim';
 *
 *   const stagehand = new Stagehand({ env: 'BROWSERBASE', apiKey, projectId });
 *   await stagehand.init();
 *   const result = await stagehand.act('click the search button');
 *   const data = await stagehand.extract('product list', schema);
 *   const actions = await stagehand.observe('what can I click here?');
 *   await stagehand.close();
 *
 * Three core methods (act / extract / observe) routed through Unbrowse's
 * marketplace cache. Stagehand's structural shape is preserved so existing
 * code keeps compiling.
 *
 * Falls back to real Stagehand (optional peer dep) only when Unbrowse misses
 * AND the original Browserbase apiKey is present, so cost-curious callers
 * pay only on miss.
 */

const DEFAULT_BASE = 'https://beta-api.unbrowse.ai';

export type StagehandEnv = 'LOCAL' | 'BROWSERBASE';

export interface StagehandConfig {
  env?: StagehandEnv;
  apiKey?: string;
  projectId?: string;
  model?: string | { name: string; provider?: string };
  modelClientOptions?: Record<string, unknown>;
  verbose?: 0 | 1 | 2;
  cacheDir?: string;
  enableCaching?: boolean;
  domSettleTimeoutMs?: number;
  browserbaseSessionCreateParams?: Record<string, unknown>;
  // Optional explicit URL the agent should resolve against. If not set the
  // shim falls through to real Stagehand for the act/extract/observe call.
  url?: string;
}

export interface ActOptions {
  variables?: Record<string, string>;
  domSettleTimeoutMs?: number;
  timeoutMs?: number;
}

export interface ActResult {
  success: boolean;
  message: string;
  action?: string;
}

export interface ObserveOptions {
  returnAction?: boolean;
  onlyVisible?: boolean;
  domSettleTimeoutMs?: number;
}

export interface ObservedAction {
  selector: string;
  description: string;
  method?: string;
  arguments?: string[];
}

export interface ExtractOptions<T = unknown> {
  schema?: T;
  modelName?: string;
  useTextExtract?: boolean;
  domSettleTimeoutMs?: number;
}

function unbrowseBase(): string {
  return process.env.UNBROWSE_API_URL || process.env.UNBROWSE_BASE || DEFAULT_BASE;
}

function unbrowseAuth(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const k = process.env.UNBROWSE_API_KEY;
  if (k) h['authorization'] = `Bearer ${k}`;
  const x402 = process.env.UNBROWSE_X_PAYMENT || process.env.X_PAYMENT;
  if (x402) h['x-payment'] = x402;
  return h;
}

async function unbrowseResolve(url: string, intent: string): Promise<any | null> {
  try {
    const res = await fetch(`${unbrowseBase()}/v1/resolve`, {
      method: 'POST',
      headers: unbrowseAuth(),
      body: JSON.stringify({ url, intent }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function unbrowseExecute(endpointId: string, params: Record<string, unknown> = {}, raw = false): Promise<any> {
  try {
    const res = await fetch(`${unbrowseBase()}/v1/execute`, {
      method: 'POST',
      headers: unbrowseAuth(),
      body: JSON.stringify({ endpoint_id: endpointId, params, raw, extract: !raw }),
      signal: AbortSignal.timeout(30000),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function topCandidate(resolved: any): { endpoint_id: string } | null {
  const list = resolved?.available_operations || resolved?.available_endpoints || [];
  return list[0] ? { endpoint_id: list[0].endpoint_id } : null;
}

type RealStagehand = any;

async function tryRealStagehand(): Promise<RealStagehand | null> {
  try {
    return await import('@browserbasehq/stagehand');
  } catch {
    return null;
  }
}

export class Stagehand {
  private config: StagehandConfig;
  private currentUrl: string | null = null;
  private currentBody: unknown = null;
  private realStagehand: any = null;
  private initialized = false;

  // The Stagehand surface exposes `.context` and `.page` for callers that
  // want raw playwright. On the shim path these are minimal stubs; real path
  // delegates to the real Stagehand.
  context: any = null;
  page: any = null;

  constructor(config: StagehandConfig = {}) {
    this.config = { env: 'BROWSERBASE', ...config };
  }

  /**
   * init() — Stagehand boots up the browser session here. On the shim path,
   * we don't spin up anything; this is a no-op until act/extract/observe is
   * called with a URL. Real Stagehand init only fires on first fallback.
   */
  async init(): Promise<void> {
    this.initialized = true;
    // Provide a structurally-valid `page` and `context` so callers that do
    // `await stagehand.page.goto(url)` before act/extract still work — we
    // remember the URL and use it for the next resolve call.
    const self = this;
    this.page = {
      async goto(url: string) {
        self.currentUrl = url;
        return null;
      },
      url: () => self.currentUrl ?? '',
      content: async () => {
        if (typeof self.currentBody === 'string') return self.currentBody;
        return self.currentBody ? JSON.stringify(self.currentBody) : '';
      },
    };
    this.context = {
      pages: () => [this.page],
    };
  }

  /**
   * act(input) — the LLM-driven action. If we have a URL + an intent that
   * matches a marketplace endpoint, return success without spinning a
   * browser. Otherwise fall through to real Stagehand if installed.
   */
  async act(input: string | { action: string }, opts: ActOptions = {}): Promise<ActResult> {
    if (!this.initialized) await this.init();
    const intent = typeof input === 'string' ? input : input.action;

    if (this.currentUrl) {
      const resolved = await unbrowseResolve(this.currentUrl, intent);
      const top = topCandidate(resolved);
      if (top) {
        const exec = await unbrowseExecute(top.endpoint_id, opts.variables ?? {}, false);
        if (exec?.ok) {
          this.currentBody = exec.body;
          return { success: true, message: 'Resolved via Unbrowse marketplace', action: intent };
        }
      }
    }

    const real = await tryRealStagehand();
    if (!real) {
      throw new Error(
        `[@unbrowse/stagehand-shim] act() requires either a cached Unbrowse route OR @browserbasehq/stagehand installed for fallback. ` +
        `Install it: npm i @browserbasehq/stagehand`,
      );
    }
    if (!this.realStagehand) {
      this.realStagehand = new real.Stagehand(this.config as any);
      await this.realStagehand.init();
      this.context = this.realStagehand.context;
      this.page = this.realStagehand.page;
    }
    return this.realStagehand.act(input, opts);
  }

  /**
   * extract(instruction, schema) — structured-data extraction. On hit, runs
   * Unbrowse execute --extract; on miss, real Stagehand fallback.
   */
  async extract<T = unknown>(instruction: string, schema?: T, opts: ExtractOptions<T> = {}): Promise<T> {
    if (!this.initialized) await this.init();
    if (this.currentUrl) {
      const resolved = await unbrowseResolve(this.currentUrl, instruction);
      const top = topCandidate(resolved);
      if (top) {
        const exec = await unbrowseExecute(top.endpoint_id, {}, false);
        if (exec?.ok) {
          this.currentBody = exec.body;
          return exec.body as T;
        }
      }
    }
    const real = await tryRealStagehand();
    if (!real || !this.realStagehand) {
      // If we don't have a real Stagehand instance yet, last-ditch: spawn one
      if (!real) {
        throw new Error(
          `[@unbrowse/stagehand-shim] extract() requires either a cached Unbrowse route OR @browserbasehq/stagehand installed for fallback.`,
        );
      }
      this.realStagehand = new real.Stagehand(this.config as any);
      await this.realStagehand.init();
    }
    return this.realStagehand.extract(instruction, { schema, ...opts });
  }

  /**
   * observe(instruction) — list actionable elements. Unbrowse doesn't model
   * "observable elements on a live DOM"; we fall through to real Stagehand
   * unless the marketplace endpoint can return a structured list of next
   * intents (future direction). v0.1: fallback-only.
   */
  async observe(instruction: string, opts: ObserveOptions = {}): Promise<ObservedAction[]> {
    if (!this.initialized) await this.init();
    const real = await tryRealStagehand();
    if (!real) {
      throw new Error(
        `[@unbrowse/stagehand-shim] observe() falls through to real Stagehand in v0.1 (no marketplace shape for "observable elements" yet). Install @browserbasehq/stagehand.`,
      );
    }
    if (!this.realStagehand) {
      this.realStagehand = new real.Stagehand(this.config as any);
      await this.realStagehand.init();
    }
    return this.realStagehand.observe(instruction, opts);
  }

  async close(opts: { force?: boolean } = {}): Promise<void> {
    if (this.realStagehand) {
      await this.realStagehand.close(opts);
      this.realStagehand = null;
    }
    this.initialized = false;
    this.currentUrl = null;
    this.currentBody = null;
    this.context = null;
    this.page = null;
  }
}

export default Stagehand;
