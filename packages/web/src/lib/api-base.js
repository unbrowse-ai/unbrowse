const rawApiBase = (import.meta.env.VITE_API_BASE || '').trim();

export const API_BASE = rawApiBase.replace(/\/+$/, '');

export function apiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${normalizedPath}`;
}
