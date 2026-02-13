const rawApiBase = (import.meta.env.VITE_API_BASE || '').trim();

// Default keeps prod working even if env isn't set.
export const API_BASE = (rawApiBase.replace(/\/+$/, '') || 'https://index.unbrowse.ai');

export function apiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${normalizedPath}`;
}

