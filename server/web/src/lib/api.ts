// API client for Clawd Skills marketplace

export interface Skill {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  endpoints: Endpoint[];
  authType?: string;
  tags?: string[];
  downloads?: number;
  price?: number;
  icon?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Endpoint {
  method: string;
  path: string;
  description?: string;
}

export interface SearchResult {
  skills: Skill[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LeaderboardEntry {
  rank: number;
  skill: Skill;
  downloads: number;
}

export interface LeaderboardResult {
  entries: LeaderboardEntry[];
}

const API_BASE = '/abilities';

export async function searchSkills(
  query?: string,
  category?: string,
  page = 1,
  pageSize = 20
): Promise<SearchResult> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (category && category !== 'all') params.set('category', category);
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));

  const resp = await fetch(`${API_BASE}/search?${params}`);
  if (!resp.ok) {
    throw new Error(`Search failed: ${resp.status}`);
  }
  return resp.json();
}

export async function getSkill(id: string): Promise<Skill> {
  const resp = await fetch(`${API_BASE}/skills/${encodeURIComponent(id)}`);
  if (!resp.ok) {
    throw new Error(`Failed to get skill: ${resp.status}`);
  }
  return resp.json();
}

export async function getLeaderboard(limit = 10): Promise<LeaderboardResult> {
  const resp = await fetch(`${API_BASE}/leaderboard?limit=${limit}`);
  if (!resp.ok) {
    throw new Error(`Failed to get leaderboard: ${resp.status}`);
  }
  return resp.json();
}

export async function downloadSkill(
  id: string,
  paymentSignature?: string
): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (paymentSignature) {
    headers['X-Payment-Signature'] = paymentSignature;
  }

  const resp = await fetch(`${API_BASE}/skills/${encodeURIComponent(id)}/download`, {
    headers,
  });

  if (resp.status === 402) {
    const paymentInfo = await resp.json();
    throw new PaymentRequiredError(paymentInfo);
  }

  if (!resp.ok) {
    throw new Error(`Download failed: ${resp.status}`);
  }

  return resp.blob();
}

export class PaymentRequiredError extends Error {
  constructor(public paymentInfo: {
    amount: number;
    currency: string;
    recipient: string;
    memo?: string;
  }) {
    super('Payment required');
    this.name = 'PaymentRequiredError';
  }
}

export async function getCategories(): Promise<string[]> {
  const resp = await fetch(`${API_BASE}/categories`);
  if (!resp.ok) {
    return ['all', 'ecommerce', 'social', 'productivity', 'finance', 'travel'];
  }
  return resp.json();
}

export async function getStats(): Promise<{
  totalSkills: number;
  totalDownloads: number;
  totalAuthors: number;
}> {
  const resp = await fetch(`${API_BASE}/stats`);
  if (!resp.ok) {
    return { totalSkills: 0, totalDownloads: 0, totalAuthors: 0 };
  }
  return resp.json();
}
