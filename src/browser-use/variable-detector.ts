/**
 * Browser-Use TypeScript Port - Variable Detector
 *
 * Automatic detection and tracking of variables, credentials, and session data.
 * Extracts values from forms, cookies, storage, and page content.
 *
 * Features:
 * - Auto-extract credentials from forms
 * - Session/cookie value tracking
 * - Cross-page variable correlation
 * - Secure masking for sensitive data
 * - Pattern-based value detection
 */

import type { Page } from "playwright";
import type { BrowserState, InteractiveElement } from "./types.js";

/**
 * Variable types for classification
 */
export type VariableType =
  | "credential"
  | "session"
  | "identifier"
  | "token"
  | "url"
  | "email"
  | "phone"
  | "address"
  | "payment"
  | "custom";

/**
 * Detected variable
 */
export interface DetectedVariable {
  /** Variable name/key */
  name: string;
  /** Variable value */
  value: string;
  /** Variable type */
  type: VariableType;
  /** Source of the variable */
  source: "form" | "cookie" | "storage" | "url" | "content" | "header";
  /** Confidence score (0-1) */
  confidence: number;
  /** Whether this is sensitive data */
  sensitive: boolean;
  /** When it was detected */
  timestamp: number;
  /** Page URL where detected */
  pageUrl: string;
}

/**
 * Pattern for variable detection
 */
interface DetectionPattern {
  name: string;
  type: VariableType;
  patterns: RegExp[];
  sensitive: boolean;
  fieldNames?: string[];
  fieldTypes?: string[];
}

/**
 * Variable detector configuration
 */
export interface VariableDetectorConfig {
  /** Enable form field detection */
  detectForms?: boolean;
  /** Enable cookie detection */
  detectCookies?: boolean;
  /** Enable storage detection */
  detectStorage?: boolean;
  /** Enable URL parameter detection */
  detectUrlParams?: boolean;
  /** Enable content scanning */
  detectContent?: boolean;
  /** Custom patterns to detect */
  customPatterns?: DetectionPattern[];
  /** Fields to ignore */
  ignoreFields?: string[];
  /** Mask sensitive values in output */
  maskSensitive?: boolean;
}

// Default detection patterns
const DEFAULT_PATTERNS: DetectionPattern[] = [
  // Credentials
  {
    name: "email",
    type: "email",
    patterns: [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/],
    sensitive: false,
    fieldNames: ["email", "e-mail", "mail", "username", "login"],
    fieldTypes: ["email"],
  },
  {
    name: "password",
    type: "credential",
    patterns: [],
    sensitive: true,
    fieldNames: ["password", "passwd", "pass", "pwd", "secret"],
    fieldTypes: ["password"],
  },
  {
    name: "username",
    type: "credential",
    patterns: [],
    sensitive: false,
    fieldNames: ["username", "user", "login", "userid", "user_id", "account"],
    fieldTypes: [],
  },

  // Session/Auth
  {
    name: "sessionId",
    type: "session",
    patterns: [
      /session[_-]?id[=:]\s*([a-zA-Z0-9_-]+)/i,
      /PHPSESSID[=:]\s*([a-zA-Z0-9]+)/i,
      /JSESSIONID[=:]\s*([a-zA-Z0-9._-]+)/i,
    ],
    sensitive: true,
    fieldNames: [],
    fieldTypes: [],
  },
  {
    name: "authToken",
    type: "token",
    patterns: [
      /bearer\s+([a-zA-Z0-9._-]+)/i,
      /auth[_-]?token[=:]\s*([a-zA-Z0-9._-]+)/i,
      /access[_-]?token[=:]\s*([a-zA-Z0-9._-]+)/i,
      /jwt[=:]\s*([a-zA-Z0-9._-]+)/i,
    ],
    sensitive: true,
    fieldNames: [],
    fieldTypes: [],
  },
  {
    name: "apiKey",
    type: "token",
    patterns: [
      /api[_-]?key[=:]\s*([a-zA-Z0-9_-]+)/i,
      /x-api-key[=:]\s*([a-zA-Z0-9_-]+)/i,
    ],
    sensitive: true,
    fieldNames: ["api_key", "apikey", "api-key"],
    fieldTypes: [],
  },
  {
    name: "csrfToken",
    type: "token",
    patterns: [
      /csrf[_-]?token[=:]\s*([a-zA-Z0-9_-]+)/i,
      /_token[=:]\s*([a-zA-Z0-9_-]+)/i,
    ],
    sensitive: true,
    fieldNames: ["csrf", "csrf_token", "_token", "authenticity_token"],
    fieldTypes: ["hidden"],
  },

  // Identifiers
  {
    name: "userId",
    type: "identifier",
    patterns: [
      /user[_-]?id[=:]\s*([a-zA-Z0-9_-]+)/i,
      /uid[=:]\s*([a-zA-Z0-9_-]+)/i,
    ],
    sensitive: false,
    fieldNames: [],
    fieldTypes: [],
  },
  {
    name: "orderId",
    type: "identifier",
    patterns: [
      /order[_-]?id[=:]\s*([a-zA-Z0-9_-]+)/i,
      /order[_-]?number[=:]\s*([a-zA-Z0-9_-]+)/i,
    ],
    sensitive: false,
    fieldNames: [],
    fieldTypes: [],
  },

  // Contact
  {
    name: "phone",
    type: "phone",
    patterns: [
      /\+?[\d\s()-]{10,}/,
    ],
    sensitive: false,
    fieldNames: ["phone", "tel", "telephone", "mobile", "cell"],
    fieldTypes: ["tel"],
  },

  // Payment
  {
    name: "cardNumber",
    type: "payment",
    patterns: [
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
    ],
    sensitive: true,
    fieldNames: ["card", "cc", "credit_card", "cardnumber", "card_number"],
    fieldTypes: [],
  },
  {
    name: "cvv",
    type: "payment",
    patterns: [/\b\d{3,4}\b/],
    sensitive: true,
    fieldNames: ["cvv", "cvc", "security_code", "card_code"],
    fieldTypes: [],
  },
];

/**
 * Variable Detector - Auto-detect and track variables
 */
export class VariableDetector {
  private page: Page;
  private config: Required<VariableDetectorConfig>;
  private variables = new Map<string, DetectedVariable>();
  private patterns: DetectionPattern[];

  constructor(page: Page, config: VariableDetectorConfig = {}) {
    this.page = page;
    this.config = {
      detectForms: config.detectForms ?? true,
      detectCookies: config.detectCookies ?? true,
      detectStorage: config.detectStorage ?? true,
      detectUrlParams: config.detectUrlParams ?? true,
      detectContent: config.detectContent ?? false,
      customPatterns: config.customPatterns ?? [],
      ignoreFields: config.ignoreFields ?? [],
      maskSensitive: config.maskSensitive ?? true,
    };
    this.patterns = [...DEFAULT_PATTERNS, ...this.config.customPatterns];
  }

  /**
   * Detect variables from current page state
   */
  async detect(): Promise<DetectedVariable[]> {
    const detected: DetectedVariable[] = [];
    const pageUrl = this.page.url();

    // Detect from forms
    if (this.config.detectForms) {
      const formVars = await this.detectFromForms(pageUrl);
      detected.push(...formVars);
    }

    // Detect from cookies
    if (this.config.detectCookies) {
      const cookieVars = await this.detectFromCookies(pageUrl);
      detected.push(...cookieVars);
    }

    // Detect from storage
    if (this.config.detectStorage) {
      const storageVars = await this.detectFromStorage(pageUrl);
      detected.push(...storageVars);
    }

    // Detect from URL
    if (this.config.detectUrlParams) {
      const urlVars = this.detectFromUrl(pageUrl);
      detected.push(...urlVars);
    }

    // Store all detected variables
    for (const v of detected) {
      const key = `${v.source}:${v.name}`;
      this.variables.set(key, v);
    }

    return detected;
  }

  /**
   * Detect variables from form fields
   */
  private async detectFromForms(pageUrl: string): Promise<DetectedVariable[]> {
    const detected: DetectedVariable[] = [];

    const formData = await this.page.evaluate(() => {
      const fields: Array<{
        name: string;
        type: string;
        value: string;
        id: string;
        placeholder: string;
        ariaLabel: string;
      }> = [];

      const inputs = document.querySelectorAll("input, select, textarea");
      for (const input of inputs) {
        const el = input as HTMLInputElement;
        fields.push({
          name: el.name || el.id || "",
          type: el.type || "text",
          value: el.value || "",
          id: el.id || "",
          placeholder: el.placeholder || "",
          ariaLabel: el.getAttribute("aria-label") || "",
        });
      }

      return fields;
    });

    for (const field of formData) {
      if (!field.value || this.config.ignoreFields.includes(field.name)) {
        continue;
      }

      // Match against patterns
      for (const pattern of this.patterns) {
        const fieldNameLower = field.name.toLowerCase();
        const matchesFieldName = pattern.fieldNames?.some(fn =>
          fieldNameLower.includes(fn.toLowerCase())
        );
        const matchesFieldType = pattern.fieldTypes?.includes(field.type);

        if (matchesFieldName || matchesFieldType) {
          detected.push({
            name: pattern.name,
            value: field.value,
            type: pattern.type,
            source: "form",
            confidence: 0.9,
            sensitive: pattern.sensitive,
            timestamp: Date.now(),
            pageUrl,
          });
          break;
        }

        // Pattern matching on value
        for (const regex of pattern.patterns) {
          const match = field.value.match(regex);
          if (match) {
            detected.push({
              name: pattern.name,
              value: match[1] || match[0],
              type: pattern.type,
              source: "form",
              confidence: 0.7,
              sensitive: pattern.sensitive,
              timestamp: Date.now(),
              pageUrl,
            });
            break;
          }
        }
      }
    }

    return detected;
  }

  /**
   * Detect variables from cookies
   */
  private async detectFromCookies(pageUrl: string): Promise<DetectedVariable[]> {
    const detected: DetectedVariable[] = [];

    const cookies = await this.page.context().cookies();

    for (const cookie of cookies) {
      // Check for session cookies
      const nameLower = cookie.name.toLowerCase();

      if (
        nameLower.includes("session") ||
        nameLower.includes("sid") ||
        nameLower === "phpsessid" ||
        nameLower === "jsessionid"
      ) {
        detected.push({
          name: `cookie_${cookie.name}`,
          value: cookie.value,
          type: "session",
          source: "cookie",
          confidence: 0.95,
          sensitive: true,
          timestamp: Date.now(),
          pageUrl,
        });
        continue;
      }

      // Check for auth tokens
      if (
        nameLower.includes("token") ||
        nameLower.includes("auth") ||
        nameLower.includes("jwt")
      ) {
        detected.push({
          name: `cookie_${cookie.name}`,
          value: cookie.value,
          type: "token",
          source: "cookie",
          confidence: 0.9,
          sensitive: true,
          timestamp: Date.now(),
          pageUrl,
        });
        continue;
      }

      // Check for user identifiers
      if (
        nameLower.includes("user") ||
        nameLower.includes("uid") ||
        nameLower.includes("id")
      ) {
        detected.push({
          name: `cookie_${cookie.name}`,
          value: cookie.value,
          type: "identifier",
          source: "cookie",
          confidence: 0.7,
          sensitive: false,
          timestamp: Date.now(),
          pageUrl,
        });
      }
    }

    return detected;
  }

  /**
   * Detect variables from localStorage/sessionStorage
   * NOTE: Many sites (Grab, Foodpanda, etc.) block this as bot detection.
   * Disabled by default in agent.ts. Fails silently if blocked.
   */
  private async detectFromStorage(pageUrl: string): Promise<DetectedVariable[]> {
    const detected: DetectedVariable[] = [];

    let storageData: Array<{ key: string; value: string; storage: "local" | "session" }> = [];
    try {
      storageData = await this.page.evaluate(() => {
        const data: Array<{ key: string; value: string; storage: "local" | "session" }> = [];

        try {
          // localStorage
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) {
              data.push({ key, value: localStorage.getItem(key) || "", storage: "local" });
            }
          }
        } catch { /* blocked */ }

        try {
          // sessionStorage
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key) {
              data.push({ key, value: sessionStorage.getItem(key) || "", storage: "session" });
            }
          }
        } catch { /* blocked */ }

        return data;
      });
    } catch {
      // Storage access blocked by security policy - fail silently
      return [];
    }

    for (const item of storageData) {
      const keyLower = item.key.toLowerCase();

      // Token detection
      if (keyLower.includes("token") || keyLower.includes("jwt") || keyLower.includes("auth")) {
        detected.push({
          name: `${item.storage}_${item.key}`,
          value: item.value,
          type: "token",
          source: "storage",
          confidence: 0.9,
          sensitive: true,
          timestamp: Date.now(),
          pageUrl,
        });
        continue;
      }

      // User data detection
      if (keyLower.includes("user") || keyLower.includes("account") || keyLower.includes("profile")) {
        detected.push({
          name: `${item.storage}_${item.key}`,
          value: item.value,
          type: "identifier",
          source: "storage",
          confidence: 0.7,
          sensitive: false,
          timestamp: Date.now(),
          pageUrl,
        });
        continue;
      }

      // Session detection
      if (keyLower.includes("session") || keyLower.includes("state")) {
        detected.push({
          name: `${item.storage}_${item.key}`,
          value: item.value,
          type: "session",
          source: "storage",
          confidence: 0.8,
          sensitive: true,
          timestamp: Date.now(),
          pageUrl,
        });
      }
    }

    return detected;
  }

  /**
   * Detect variables from URL parameters
   */
  private detectFromUrl(pageUrl: string): DetectedVariable[] {
    const detected: DetectedVariable[] = [];

    try {
      const url = new URL(pageUrl);

      for (const [key, value] of url.searchParams) {
        const keyLower = key.toLowerCase();

        // Token/auth params
        if (keyLower.includes("token") || keyLower.includes("auth") || keyLower.includes("key")) {
          detected.push({
            name: `url_${key}`,
            value,
            type: "token",
            source: "url",
            confidence: 0.85,
            sensitive: true,
            timestamp: Date.now(),
            pageUrl,
          });
          continue;
        }

        // ID params
        if (keyLower.includes("id") || keyLower === "uid" || keyLower === "ref") {
          detected.push({
            name: `url_${key}`,
            value,
            type: "identifier",
            source: "url",
            confidence: 0.7,
            sensitive: false,
            timestamp: Date.now(),
            pageUrl,
          });
        }
      }
    } catch {
      // Invalid URL, skip
    }

    return detected;
  }

  /**
   * Get all detected variables
   */
  getAll(): DetectedVariable[] {
    return Array.from(this.variables.values());
  }

  /**
   * Get variables by type
   */
  getByType(type: VariableType): DetectedVariable[] {
    return this.getAll().filter(v => v.type === type);
  }

  /**
   * Get variables by source
   */
  getBySource(source: DetectedVariable["source"]): DetectedVariable[] {
    return this.getAll().filter(v => v.source === source);
  }

  /**
   * Get a specific variable
   */
  get(name: string): DetectedVariable | undefined {
    for (const v of this.variables.values()) {
      if (v.name === name || v.name.endsWith(`_${name}`)) {
        return v;
      }
    }
    return undefined;
  }

  /**
   * Get masked value for display
   */
  getMasked(name: string): string | undefined {
    const v = this.get(name);
    if (!v) return undefined;

    if (this.config.maskSensitive && v.sensitive && v.value.length > 4) {
      return v.value.slice(0, 2) + "*".repeat(v.value.length - 4) + v.value.slice(-2);
    }
    return v.value;
  }

  /**
   * Format variables for LLM context
   */
  formatForLLM(): string {
    const lines: string[] = ["Detected Variables:"];

    const byType = new Map<VariableType, DetectedVariable[]>();
    for (const v of this.variables.values()) {
      const list = byType.get(v.type) ?? [];
      list.push(v);
      byType.set(v.type, list);
    }

    for (const [type, vars] of byType) {
      lines.push(`  ${type}:`);
      for (const v of vars) {
        const value = this.config.maskSensitive && v.sensitive
          ? this.getMasked(v.name)
          : v.value;
        lines.push(`    ${v.name}: ${value} (from ${v.source})`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Export variables as key-value pairs
   */
  export(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const v of this.variables.values()) {
      result[v.name] = v.value;
    }
    return result;
  }

  /**
   * Clear all detected variables
   */
  clear(): void {
    this.variables.clear();
  }

  /**
   * Update page reference
   */
  setPage(page: Page): void {
    this.page = page;
  }
}

/**
 * Create a variable detector for a page
 */
export function createVariableDetector(
  page: Page,
  config?: VariableDetectorConfig
): VariableDetector {
  return new VariableDetector(page, config);
}
