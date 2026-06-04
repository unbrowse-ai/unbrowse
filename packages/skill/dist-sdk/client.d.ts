import type { AccountMe, AccountCredits, ApiKeyCreateInput, ApiKeyCreateResponse, ApiKeyListResponse, ApiKeyRevokeResponse, ExecuteInput, ExecuteResponse, HealthResponse, RequestOptions, ResolveInput, ResolveResponse, SearchInput, SearchResponse, SponsorStatus, UnbrowseClientOptions } from "./types.js";
import type { WorkerProxyCapabilities, WorkerProxyRequest, WorkerProxyResponse } from "./proxy-types.js";
export declare class Unbrowse {
    readonly apiKey: string | undefined;
    readonly baseURL: string;
    readonly timeout: number;
    readonly maxRetries: number;
    readonly logLevel: NonNullable<UnbrowseClientOptions["logLevel"]>;
    private readonly _fetch;
    private readonly defaultHeaders;
    readonly account: AccountResource;
    readonly keys: KeysResource;
    readonly proxy: ProxyResource;
    constructor(opts?: UnbrowseClientOptions);
    resolve(input: ResolveInput, opts?: RequestOptions): Promise<ResolveResponse>;
    execute(input: ExecuteInput, opts?: RequestOptions): Promise<ExecuteResponse>;
    search(input: SearchInput, opts?: RequestOptions): Promise<SearchResponse>;
    health(opts?: RequestOptions): Promise<HealthResponse>;
    request<T>(method: string, path: string, body: unknown, opts: RequestOptions): Promise<T>;
    private debug;
}
declare class AccountResource {
    private readonly client;
    constructor(client: Unbrowse);
    me(opts?: RequestOptions): Promise<AccountMe>;
    credits(opts?: RequestOptions): Promise<AccountCredits>;
    sponsorStatus(opts?: RequestOptions): Promise<SponsorStatus>;
}
declare class KeysResource {
    private readonly client;
    constructor(client: Unbrowse);
    list(opts?: RequestOptions): Promise<ApiKeyListResponse>;
    create(input?: ApiKeyCreateInput, opts?: RequestOptions): Promise<ApiKeyCreateResponse>;
    revoke(keyId: string, opts?: RequestOptions): Promise<ApiKeyRevokeResponse>;
    rotate(keyId: string, opts?: RequestOptions): Promise<ApiKeyCreateResponse>;
}
declare class ProxyResource {
    private readonly client;
    constructor(client: Unbrowse);
    fetch(req: WorkerProxyRequest, opts?: RequestOptions): Promise<WorkerProxyResponse>;
    capabilities(opts?: RequestOptions): Promise<WorkerProxyCapabilities>;
}
export {};
