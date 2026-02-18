/**
 * Workflow Recorder — Records multi-site browsing sessions for workflow learning.
 *
 * Captures navigation, API calls, and user actions across multiple domains.
 * Sessions are saved for later analysis by the workflow learner.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  RecordedSession,
  RecordedEntry,
  SessionAnnotation,
  BrowserAction,
} from "./workflow-types.js";

/** Active recording session state */
interface ActiveSession {
  session: RecordedSession;
  outputPath: string;
  domains: Set<string>;
  lastSaveTime: number;
}

export class WorkflowRecorder {
  private activeSession: ActiveSession | null = null;
  private recordingsDir: string;
  private autoSaveInterval: number = 5000; // Save every 5s

  constructor(baseDir?: string) {
    this.recordingsDir = baseDir || join(homedir(), ".openclaw", "workflow-recordings");
    if (!existsSync(this.recordingsDir)) {
      mkdirSync(this.recordingsDir, { recursive: true });
    }
  }

  /** Start a new recording session */
  startSession(intent?: string): string {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: RecordedSession = {
      sessionId,
      startTime: new Date().toISOString(),
      domains: [],
      entries: [],
      annotations: [],
      detectedIntent: intent,
    };

    const outputPath = join(this.recordingsDir, `${sessionId}.json`);
    this.activeSession = {
      session,
      outputPath,
      domains: new Set(),
      lastSaveTime: Date.now(),
    };

    this.saveSession();
    return sessionId;
  }

  /** Stop recording and finalize session */
  stopSession(): RecordedSession | null {
    if (!this.activeSession) return null;

    const session = this.activeSession.session;
    session.endTime = new Date().toISOString();
    session.domains = Array.from(this.activeSession.domains);

    this.saveSession();
    const result = { ...session };
    this.activeSession = null;
    return result;
  }

  /** Record a navigation event */
  recordNavigation(url: string, cookies?: Record<string, string>): void {
    if (!this.activeSession) return;

    const domain = new URL(url).hostname;
    this.activeSession.domains.add(domain);

    const entry: RecordedEntry = {
      timestamp: new Date().toISOString(),
      type: "navigation",
      domain,
      url,
      cookies,
    };

    this.activeSession.session.entries.push(entry);
    this.maybeAutoSave();
  }

  /** Record an API call */
  recordApiCall(
    method: string,
    url: string,
    requestBody?: any,
    responseBody?: any,
    responseStatus?: number,
    headers?: Record<string, string>,
    cookies?: Record<string, string>
  ): void {
    if (!this.activeSession) return;

    const domain = new URL(url).hostname;
    this.activeSession.domains.add(domain);

    // Summarize large response bodies
    const summarizedResponse = this.summarizeBody(responseBody);

    const entry: RecordedEntry = {
      timestamp: new Date().toISOString(),
      type: "api-call",
      domain,
      url,
      method,
      requestBody,
      responseBody: summarizedResponse,
      responseStatus,
      headers: this.sanitizeHeaders(headers),
      cookies,
    };

    this.activeSession.session.entries.push(entry);
    this.maybeAutoSave();
  }

  /** Record a browser action (click, type, etc.) */
  recordAction(
    url: string,
    action: BrowserAction,
    domSnapshot?: string
  ): void {
    if (!this.activeSession) return;

    const domain = new URL(url).hostname;
    this.activeSession.domains.add(domain);

    const entry: RecordedEntry = {
      timestamp: new Date().toISOString(),
      type: "action",
      domain,
      url,
      action,
      domSnapshot,
    };

    this.activeSession.session.entries.push(entry);
    this.maybeAutoSave();
  }

  /** Record a page load event */
  recordPageLoad(url: string, cookies?: Record<string, string>): void {
    if (!this.activeSession) return;

    const domain = new URL(url).hostname;
    this.activeSession.domains.add(domain);

    const entry: RecordedEntry = {
      timestamp: new Date().toISOString(),
      type: "page-load",
      domain,
      url,
      cookies,
    };

    this.activeSession.session.entries.push(entry);
    this.maybeAutoSave();
  }

  /** Add a user annotation to the current session */
  addAnnotation(note: string, type: SessionAnnotation["type"] = "important"): void {
    if (!this.activeSession) return;

    const annotation: SessionAnnotation = {
      timestamp: new Date().toISOString(),
      stepIndex: this.activeSession.session.entries.length - 1,
      note,
      type,
    };

    this.activeSession.session.annotations.push(annotation);
    this.maybeAutoSave();
  }

  /** Get current session info */
  getSessionInfo(): { sessionId: string; entryCount: number; domains: string[] } | null {
    if (!this.activeSession) return null;
    return {
      sessionId: this.activeSession.session.sessionId,
      entryCount: this.activeSession.session.entries.length,
      domains: Array.from(this.activeSession.domains),
    };
  }

  /** Check if actively recording */
  isRecording(): boolean {
    return this.activeSession !== null;
  }

  /** Load a recorded session by ID */
  loadSession(sessionId: string): RecordedSession | null {
    const path = join(this.recordingsDir, `${sessionId}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  }

  /** List all recorded sessions */
  listSessions(): Array<{ sessionId: string; startTime: string; domains: string[] }> {
    const files = require("node:fs").readdirSync(this.recordingsDir) as string[];
    const sessions: Array<{ sessionId: string; startTime: string; domains: string[] }> = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const path = join(this.recordingsDir, file);
        const data = JSON.parse(readFileSync(path, "utf-8")) as RecordedSession;
        sessions.push({
          sessionId: data.sessionId,
          startTime: data.startTime,
          domains: data.domains,
        });
      } catch {
        continue;
      }
    }

    return sessions.sort((a, b) =>
      new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
    );
  }

  /** Summarize response body to avoid storing large payloads */
  private summarizeBody(body: any): any {
    if (body === undefined || body === null) return body;
    if (typeof body === "string") {
      if (body.length > 5000) {
        return { _truncated: true, _length: body.length, _preview: body.slice(0, 500) };
      }
      try {
        return JSON.parse(body);
      } catch {
        return body;
      }
    }
    if (Array.isArray(body)) {
      if (body.length > 10) {
        return {
          _type: "array",
          _length: body.length,
          _sample: body.slice(0, 3),
        };
      }
      return body;
    }
    if (typeof body === "object") {
      const json = JSON.stringify(body);
      if (json.length > 5000) {
        return {
          _truncated: true,
          _length: json.length,
          _keys: Object.keys(body).slice(0, 20),
        };
      }
      return body;
    }
    return body;
  }

  /** Remove sensitive headers before storing */
  private sanitizeHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
    if (!headers) return undefined;
    const sanitized: Record<string, string> = {};
    const sensitivePatterns = ["authorization", "cookie", "x-api-key", "api-key", "secret", "token"];

    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (sensitivePatterns.some((p) => lowerKey.includes(p))) {
        sanitized[key] = `[REDACTED:${value.length}chars]`;
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  /** Auto-save periodically during recording */
  private maybeAutoSave(): void {
    if (!this.activeSession) return;
    const now = Date.now();
    if (now - this.activeSession.lastSaveTime >= this.autoSaveInterval) {
      this.saveSession();
      this.activeSession.lastSaveTime = now;
    }
  }

  /** Save current session to disk */
  private saveSession(): void {
    if (!this.activeSession) return;
    const session = this.activeSession.session;
    session.domains = Array.from(this.activeSession.domains);
    writeFileSync(
      this.activeSession.outputPath,
      JSON.stringify(session, null, 2),
      "utf-8"
    );
  }
}

/** Singleton instance for the recorder */
let recorderInstance: WorkflowRecorder | null = null;

export function getWorkflowRecorder(baseDir?: string): WorkflowRecorder {
  if (!recorderInstance) {
    recorderInstance = new WorkflowRecorder(baseDir);
  }
  return recorderInstance;
}
