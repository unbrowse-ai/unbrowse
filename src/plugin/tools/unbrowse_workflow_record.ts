import type { ToolDeps } from "./deps.js";
import { WORKFLOW_RECORD_SCHEMA } from "./shared.js";

export function makeUnbrowseWorkflowRecordTool(deps: ToolDeps) {
  const { logger } = deps;

  return {
name: "unbrowse_workflow_record",
label: "Record Workflow",
description:
"Record multi-site browsing sessions to learn cross-site workflows. Start recording, " +
"browse websites, add annotations at decision points, then stop to finalize. The recorded " +
"session can be analyzed to generate either an api-package (single-site) or workflow (multi-site) skill.",
parameters: WORKFLOW_RECORD_SCHEMA,
async execute(_toolCallId: string, params: unknown) {
const p = params as {
  action: "start" | "stop" | "status" | "annotate" | "list";
  intent?: string;
  note?: string;
  noteType?: "intent" | "decision" | "important" | "skip";
};

const { getWorkflowRecorder } = await import("../../workflow-recorder.js");
const recorder = getWorkflowRecorder();

switch (p.action) {
  case "start": {
    const sessionId = recorder.startSession(p.intent);
    return {
      content: [{
        type: "text",
        text: `Recording started: ${sessionId}\n` +
          `Intent: ${p.intent || "(not specified)"}\n\n` +
          "Browse websites normally. Use 'annotate' to mark important steps or decision points.\n" +
          "When finished, use action='stop' to finalize the recording.",
      }],
    };
  }

  case "stop": {
    const session = recorder.stopSession();
    if (!session) {
      return { content: [{ type: "text", text: "No active recording to stop." }] };
    }
    const domainList = session.domains.join(", ") || "(none)";
    const category = session.domains.length > 1 ? "workflow" : "api-package";
    return {
      content: [{
        type: "text",
        text: `Recording stopped: ${session.sessionId}\n` +
          `Duration: ${new Date(session.endTime!).getTime() - new Date(session.startTime).getTime()}ms\n` +
          `Entries: ${session.entries.length}\n` +
          `Domains: ${domainList}\n` +
          `Suggested category: ${category}\n\n` +
          `Run unbrowse_workflow_learn with sessionId="${session.sessionId}" to generate a skill.`,
      }],
    };
  }

  case "status": {
    const info = recorder.getSessionInfo();
    if (!info) {
      return { content: [{ type: "text", text: "Not recording. Use action='start' to begin." }] };
    }
    return {
      content: [{
        type: "text",
        text: `Recording active: ${info.sessionId}\n` +
          `Entries: ${info.entryCount}\n` +
          `Domains: ${info.domains.join(", ") || "(none yet)"}`,
      }],
    };
  }

  case "annotate": {
    if (!p.note) {
      return { content: [{ type: "text", text: "Provide a note for the annotation." }] };
    }
    recorder.addAnnotation(p.note, p.noteType || "important");
    return { content: [{ type: "text", text: `Annotation added: [${p.noteType || "important"}] ${p.note}` }] };
  }

  case "list": {
    const sessions = recorder.listSessions();
    if (sessions.length === 0) {
      return { content: [{ type: "text", text: "No recorded sessions found." }] };
    }
    const lines = sessions.slice(0, 20).map(
      (s) => `${s.sessionId} | ${s.startTime} | ${s.domains.join(", ") || "(no domains)"}`
    );
    return { content: [{ type: "text", text: `Recent recordings:\n${lines.join("\n")}` }] };
  }

  default:
    return { content: [{ type: "text", text: `Unknown action: ${p.action}` }] };
}
},
};
}
