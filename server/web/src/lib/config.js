// Centralized API configuration
// In production (Vercel), VITE_API_BASE is set via env vars
// In development, falls back to staging
export const API_BASE = import.meta.env.VITE_API_BASE || 'https://staging-index.unbrowse.ai';
