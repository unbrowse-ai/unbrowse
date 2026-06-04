export interface WorkerProxyResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
    proxy_used: "direct" | "residential";
    duration_ms: number;
    egress_ip?: string;
    _request_id?: string;
}
export interface WorkerProxyRequest {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | null;
    proxy?: "direct" | "residential";
    timeout_ms?: number;
}
export interface WorkerProxyCapabilities {
    modes: Array<"direct" | "residential">;
    residential_configured: boolean;
    max_body_bytes: number;
    default_timeout_ms: number;
    _request_id?: string;
}
