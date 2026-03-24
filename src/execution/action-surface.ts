import { extractSPAData } from "../extraction/index.js";
import type { BundleMutationRoute } from "../reverse-engineer/bundle-scanner.js";

type ActionQuestion = {
  id: string;
  label?: string;
  required?: boolean;
  question_type?: string;
  options?: string[];
};

type ActionTicketType = {
  api_id?: string;
  id?: string;
  name?: string;
  cents?: number | null;
  amount?: number | null;
  currency?: string | null;
  type?: string | null;
  is_hidden?: boolean;
  is_disabled?: boolean;
};

export interface EmbeddedActionSurface {
  score: number;
  identifiers: Record<string, unknown>;
  defaults: Record<string, unknown>;
  profile: Record<string, unknown>;
  questions: ActionQuestion[];
  ticket_types: ActionTicketType[];
  signals: string[];
}

const ACTION_TERMS = /\b(register|registration|rsvp|join|apply|signup|sign_up|book|reserve|checkout|purchase|order|ticket|waitlist|approval|payment|coupon|guest)\b/i;
const PROFILE_KEYS = new Set([
  "name",
  "first_name",
  "last_name",
  "email",
  "phone_number",
  "telegram_username",
  "twitter_handle",
  "linkedin_handle",
  "instagram_handle",
  "github_username",
  "youtube_handle",
  "company",
  "job_title",
]);

function singularize(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses") || word.endsWith("xes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

function normalizeBindingKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[.[\]]+/g, "_")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function deriveContextKey(path: string[], key: string): string {
  const normalized = normalizeBindingKey(key);
  if (normalized !== "api_id" && normalized !== "id") return normalized;
  const context = [...path]
    .reverse()
    .map((part) => normalizeBindingKey(part))
    .find((part) => part && !/^(data|props|page_props|pageprops|initial_data|initialdata|item|items|\d+)$/.test(part));
  return context ? `${singularize(context)}_${normalized}` : normalized;
}

function extractQuestionOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      return typeof record.label === "string"
        ? record.label
        : typeof record.value === "string"
          ? record.value
          : typeof record.name === "string"
            ? record.name
            : null;
    })
    .filter((item): item is string => !!item);
  return options.length > 0 ? options : undefined;
}

function chooseQuestionBinding(question: ActionQuestion): string {
  const type = normalizeBindingKey(question.question_type ?? "");
  if (type === "phone_number") return "phone_number";
  if (type === "company") return "company";
  if (type === "linkedin") return "linkedin_handle";
  if (type === "twitter") return "twitter_handle";
  if (type === "instagram") return "instagram_handle";
  if (type === "github") return "github_username";
  if (type === "telegram") return "telegram_username";
  if (type === "youtube") return "youtube_handle";
  if (type === "url") return "url";
  return normalizeBindingKey(question.label || question.id || type || "value");
}

function buildQuestionAnswerTemplate(question: ActionQuestion, profile: Record<string, unknown>): Record<string, unknown> {
  const questionType = normalizeBindingKey(question.question_type ?? "text");
  const binding = chooseQuestionBinding(question);
  const profileValue = profile[binding];
  let value: unknown;

  switch (questionType) {
    case "company":
      value = {
        company: profile.company ?? "{company}",
        job_title: profile.job_title ?? "{job_title}",
      };
      break;
    case "multi_select":
      value = [];
      break;
    case "agree_check":
    case "terms":
      value = question.required ? true : false;
      break;
    case "dropdown":
      value = question.options?.[0] ?? `{${binding}}`;
      break;
    default:
      value = profileValue ?? `{${binding}}`;
      break;
  }

  return {
    question_id: question.id,
    question_type: question.question_type ?? "text",
    ...(question.label ? { label: question.label } : {}),
    value,
  };
}

function pickTicketSelection(ticketTypes: ActionTicketType[]): Record<string, { count: number; amount: number }> | undefined {
  const visible = ticketTypes.filter((ticket) => !ticket.is_hidden && !ticket.is_disabled);
  const choice = visible.find((ticket) => ticket.type === "free") ?? visible[0];
  const apiId = choice?.api_id ?? choice?.id;
  if (!apiId) return undefined;
  const amount = Number.isFinite(choice.cents as number)
    ? Number(choice.cents)
    : Number.isFinite(choice.amount as number)
      ? Number(choice.amount)
      : 0;
  return { [apiId]: { count: 1, amount } };
}

function visitSurfaceNode(
  node: unknown,
  path: string[],
  out: EmbeddedActionSurface,
): void {
  if (Array.isArray(node)) {
    const parentKey = normalizeBindingKey(path[path.length - 1] ?? "");
    if (
      node.length > 0 &&
      node.every((item) => item && typeof item === "object") &&
      (parentKey.includes("question") || parentKey.includes("field") || parentKey.includes("answer"))
    ) {
      const questions = node
        .map((item) => item as Record<string, unknown>)
        .filter((item) =>
          typeof item.id === "string" &&
          (typeof item.label === "string" || typeof item.question_type === "string" || typeof item.type === "string"),
        )
        .map((item) => ({
          id: String(item.id),
          ...(typeof item.label === "string" ? { label: item.label } : {}),
          ...(typeof item.required === "boolean" ? { required: item.required } : {}),
          ...(typeof item.question_type === "string"
            ? { question_type: item.question_type }
            : typeof item.type === "string"
              ? { question_type: item.type }
              : {}),
          ...(extractQuestionOptions(item.options) ? { options: extractQuestionOptions(item.options) } : {}),
        }));
      if (questions.length > 0) {
        out.questions.push(...questions);
        out.score += 20;
        out.signals.push(parentKey || "questions");
      }
    }

    if (
      node.length > 0 &&
      node.every((item) => item && typeof item === "object") &&
      (parentKey.includes("ticket") || parentKey.includes("plan") || parentKey.includes("variant"))
    ) {
      const ticketTypes = node
        .map((item) => item as Record<string, unknown>)
        .filter((item) => typeof item.api_id === "string" || typeof item.id === "string")
        .map((item) => ({
          ...(typeof item.api_id === "string" ? { api_id: item.api_id } : {}),
          ...(typeof item.id === "string" ? { id: item.id } : {}),
          ...(typeof item.name === "string" ? { name: item.name } : {}),
          ...(typeof item.type === "string" ? { type: item.type } : {}),
          ...(typeof item.currency === "string" ? { currency: item.currency } : {}),
          ...(typeof item.cents === "number" || item.cents === null ? { cents: item.cents as number | null } : {}),
          ...(typeof item.amount === "number" || item.amount === null ? { amount: item.amount as number | null } : {}),
          ...(typeof item.is_hidden === "boolean" ? { is_hidden: item.is_hidden } : {}),
          ...(typeof item.is_disabled === "boolean" ? { is_disabled: item.is_disabled } : {}),
        }));
      if (ticketTypes.length > 0) {
        out.ticket_types.push(...ticketTypes);
        out.score += 12;
        out.signals.push(parentKey || "ticket_types");
      }
    }

    node.forEach((item, index) => visitSurfaceNode(item, [...path, String(index)], out));
    return;
  }

  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const pathHintsProfile = path.some((part) => /\b(user|guest|profile|host|invitee|member|attendee)\b/i.test(part));
  const recordHintsProfile = Object.keys(record).some((key) =>
    /^(email|phone_number|twitter_handle|telegram_username|linkedin_handle|instagram_handle|github_username|youtube_handle|first_name|last_name|job_title)$/i.test(key),
  );
  const profileLike = pathHintsProfile || recordHintsProfile;

  for (const [rawKey, value] of Object.entries(record)) {
    const key = normalizeBindingKey(rawKey);
    const nextPath = [...path, rawKey];

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      if (ACTION_TERMS.test(key)) {
        out.score += 2;
        out.signals.push(key);
      }
      if (profileLike && PROFILE_KEYS.has(key) && value != null && value !== "") {
        out.profile[key] = value;
      }
      if (key.endsWith("_requirement") || key === "waitlist_active" || key === "require_approval" || key === "approval_status") {
        out.defaults[key] = value;
        out.score += 3;
        out.signals.push(key);
      }
      if (/_api_id$/.test(key) || key === "api_id" || key === "id") {
        const contextKey = deriveContextKey(path, key);
        out.identifiers[contextKey] = value;
      }
    }

    visitSurfaceNode(value, nextPath, out);
  }
}

export function inferEmbeddedActionSurface(html: string): EmbeddedActionSurface | null {
  if (!html) return null;
  const spaStructures = extractSPAData(html);
  if (spaStructures.length === 0) return null;

  const surface: EmbeddedActionSurface = {
    score: 0,
    identifiers: {},
    defaults: {},
    profile: {},
    questions: [],
    ticket_types: [],
    signals: [],
  };

  for (const structure of spaStructures) {
    visitSurfaceNode(structure.data, [], surface);
  }

  surface.questions = surface.questions.filter((question, index, list) =>
    list.findIndex((candidate) => candidate.id === question.id) === index,
  );
  surface.ticket_types = surface.ticket_types.filter((ticket, index, list) => {
    const id = ticket.api_id ?? ticket.id;
    return !!id && list.findIndex((candidate) => (candidate.api_id ?? candidate.id) === id) === index;
  });
  surface.signals = [...new Set(surface.signals)];

  if (
    surface.score <= 0 &&
    Object.keys(surface.identifiers).length === 0 &&
    surface.questions.length === 0 &&
    surface.ticket_types.length === 0
  ) {
    return null;
  }

  return surface;
}

function pickIdentifierValue(surface: EmbeddedActionSurface, key: string): unknown {
  if (surface.identifiers[key] != null) return surface.identifiers[key];
  if (key === "event_api_id" && surface.identifiers.event_api_id != null) return surface.identifiers.event_api_id;
  if (/_api_id$/.test(key)) {
    const suffix = key.replace(/^.*?_/, "");
    const match = Object.entries(surface.identifiers).find(([candidateKey]) => candidateKey.endsWith(`_${suffix}`));
    if (match) return match[1];
  }
  return undefined;
}

export function buildTemplateBodyFromSurface(
  route: BundleMutationRoute,
  surface: EmbeddedActionSurface | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const questions = surface?.questions ?? [];
  const ticketSelection = surface ? pickTicketSelection(surface.ticket_types) : undefined;
  const expectedAmountCents = ticketSelection
    ? Object.values(ticketSelection).reduce((sum, entry) => sum + entry.amount, 0)
    : 0;
  const nowTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  for (const key of route.body_keys ?? []) {
    const normalized = normalizeBindingKey(key);
    const identifierValue = surface ? pickIdentifierValue(surface, normalized) : undefined;
    if (identifierValue != null) {
      body[key] = identifierValue;
      continue;
    }

    if (surface?.profile[normalized] != null) {
      body[key] = surface.profile[normalized];
      continue;
    }

    switch (normalized) {
      case "name":
      case "first_name":
      case "last_name":
      case "email":
      case "phone_number":
        body[key] = surface?.profile[normalized] ?? `{${normalized}}`;
        break;
      case "timezone":
        body[key] = nowTimezone;
        break;
      case "for_waitlist":
        body[key] = false;
        break;
      case "registration_answers":
      case "answers":
      case "custom_field_answers":
        body[key] = questions.map((question) => buildQuestionAnswerTemplate(question, surface?.profile ?? {}));
        break;
      case "ticket_type_to_selection":
        body[key] = ticketSelection ?? {};
        break;
      case "expected_amount_cents":
        body[key] = expectedAmountCents;
        break;
      case "expected_amount_tax":
        body[key] = 0;
        break;
      case "currency":
        body[key] =
          surface?.ticket_types.find((ticket) => typeof ticket.currency === "string")?.currency ??
          null;
        break;
      case "coupon_code":
      case "payment_method":
      case "payment_currency":
      case "token_gate_info":
      case "eth_address_info":
      case "solana_address_info":
      case "solana_address":
      case "solana_wallet_type":
      case "event_invite_api_id":
        body[key] = null;
        break;
      case "opened_from":
        body[key] = "unbrowse";
        break;
      default:
        body[key] = `{${normalized}}`;
        break;
    }
  }

  return body;
}

export function scoreBundleMutationRoute(
  route: BundleMutationRoute,
  surface: EmbeddedActionSurface | null,
  intent?: string,
): number {
  let score = 0;
  const haystack = `${route.path} ${(route.body_keys ?? []).join(" ")}`.toLowerCase();
  const intentLower = (intent ?? "").toLowerCase();

  if (ACTION_TERMS.test(haystack)) score += 20;
  if (/\b(register|rsvp|join|apply|checkout|purchase)\b/.test(intentLower) && ACTION_TERMS.test(haystack)) score += 24;
  if ((route.body_keys ?? []).some((key) => /email|name|phone|answer|ticket|coupon|waitlist|invite|timezone/.test(key))) score += 18;
  if (surface) {
    if ((route.body_keys ?? []).some((key) => key in surface.identifiers)) score += 24;
    if ((route.body_keys ?? []).includes("registration_answers") && surface.questions.length > 0) score += 28;
    if ((route.body_keys ?? []).includes("ticket_type_to_selection") && surface.ticket_types.length > 0) score += 20;
    if ((route.body_keys ?? []).includes("email") && surface.profile.email != null) score += 10;
    if (surface.signals.some((signal) => ACTION_TERMS.test(signal))) score += 8;
  }
  return score;
}
