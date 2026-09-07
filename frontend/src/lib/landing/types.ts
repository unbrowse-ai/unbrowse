export interface LandingVariantContent {
  hero_eyebrow?: string;
  hero_title?: string;
  hero_highlight?: string;
  hero_body?: string;
  hero_supporting?: string;
  trust_items?: string[];
  definition_title?: string;
  definition_body?: string;
  install_summary?: string;
}

export interface LandingVariant {
  variant_id: string;
  slug: string;
  name: string;
  icp: string;
  experiment_id: string;
  status: "draft" | "active" | "archived";
  weight: number;
  content: LandingVariantContent;
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface ResolvedLandingVariantResponse {
  variant: LandingVariant | null;
}
