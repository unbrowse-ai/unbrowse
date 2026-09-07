import type { SkillManifest, ExecutionTrace } from "../types/index.js";

export interface UnbrowseResponseData {
  status: number;
  headers: Record<string, string>;
  url: string;
  body: unknown;
}

export class UnbrowseResponse {
  private _data: UnbrowseResponseData;
  constructor(data: UnbrowseResponseData) { this._data = data; }
  status(): number { return this._data.status; }
  headers(): Record<string, string> { return this._data.headers; }
  url(): string { return this._data.url; }
  async json(): Promise<unknown> { return this._data.body; }
  async text(): Promise<string> { return typeof this._data.body === "string" ? this._data.body : JSON.stringify(this._data.body); }
}

export interface GotoOptions {
  /** Override inferred intent for resolve */
  intent?: string;
  /** Timeout in ms */
  timeout?: number;
  /** Wait until condition */
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

export interface BrowserLaunchOptions {
  /** Headless mode (default true) */
  headless?: boolean;
  /** Default intent for resolve calls */
  intent?: string;
}

export interface SkillResolutionResult {
  skill: SkillManifest;
  trace: ExecutionTrace;
  result: unknown;
  source: string;
}
