/** Shared result shape every web-search provider maps onto (wire-stable). */
export interface WebResult {
  url: string;
  title?: string;
  score: number;
  highlights?: string[];
}
