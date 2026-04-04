export class UnbrowseApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly data: unknown;
  readonly headers: Headers;

  constructor(message: string, options: { status: number; path: string; data: unknown; headers: Headers }) {
    super(message);
    this.name = "UnbrowseApiError";
    this.status = options.status;
    this.path = options.path;
    this.data = options.data;
    this.headers = options.headers;
  }
}
