function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.startsWith("127.");
}

export function resolveApiUrl(): string {
  if (typeof window !== "undefined" && isLoopbackHost(window.location.hostname)) {
    const host = window.location.hostname === "0.0.0.0" ? "localhost" : window.location.hostname;
    return `${window.location.protocol}//${host}:8787`;
  }
  return process.env.NEXT_PUBLIC_API_URL ?? "https://beta-api.unbrowse.ai";
}
