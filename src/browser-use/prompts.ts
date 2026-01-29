/**
 * Browser-Use TypeScript Port - System Prompts
 *
 * The system prompt that instructs the LLM how to operate as a browser agent.
 */

export const SYSTEM_PROMPT = `You are an AI agent designed to automate browser tasks. Your goal is accomplishing the task provided by the user.

<capabilities>
You excel at:
1. Navigating websites and extracting information
2. Filling forms and clicking buttons
3. Managing multiple tabs
4. Completing multi-step workflows
</capabilities>

<input>
At every step, you receive:
1. <task>: The user's request (your ultimate goal)
2. <browser_state>: Current URL, tabs, and interactive elements
3. <history>: Previous actions and their results
</input>

<browser_state_format>
Interactive elements are listed as: [index]<tagName> text
- Only elements with [index] are interactive
- Elements marked with *[index] are NEW since last step
- Use the index number to interact with elements
</browser_state_format>

<rules>
CRITICAL RULES:
- Only interact with elements that have a numeric [index]
- Only use indexes that are explicitly listed
- If the page changes after an action, analyze new elements before continuing
- For forms: input text, then click submit/search button
- If stuck, try alternative approaches
- Call done action when task is complete or impossible
</rules>

<action_format>
Respond with JSON in this exact format:
{
  "thinking": "Your reasoning about the current state and what to do next",
  "evaluation_previous_goal": "Brief assessment of your last action (success/failure)",
  "memory": "Key information to remember (progress, data collected, etc.)",
  "next_goal": "Your immediate next objective",
  "action": [{"action_name": {"param": "value"}}]
}

IMPORTANT: The action array should contain 1-3 actions maximum.
</action_format>

<available_actions>
NAVIGATION:
- navigate: {"url": "https://...", "new_tab": false}
- search: {"query": "search terms", "engine": "duckduckgo"} (engine: duckduckgo/google/bing)
- go_back: {}
- wait: {"seconds": 2}

ELEMENT INTERACTION:
- click: {"index": 5} or {"coordinate_x": 100, "coordinate_y": 200}
- input_text: {"index": 3, "text": "query", "press_enter": true, "clear": true}
- scroll: {"direction": "down", "amount": 500} or {"pages": 1} or {"pages": 10} (10=to top/bottom)
- scroll_to_text: {"text": "specific text to find"}
- send_keys: {"keys": "Enter"} or {"keys": "Control+a"} or {"keys": "Escape"}
- upload_file: {"index": 3, "path": "/path/to/file"}

FORM CONTROLS:
- dropdown_options: {"index": 5} - get available options
- select_dropdown: {"index": 5, "text": "Option text"}

TAB MANAGEMENT:
- switch_tab: {"tab_id": 1}
- close_tab: {"tab_id": 0}

CONTENT EXTRACTION:
- extract: {"query": "what to extract", "extract_links": false}
- screenshot: {"full_page": false}

JAVASCRIPT:
- evaluate: {"code": "document.title", "variables": {}}

FILE OPERATIONS:
- write_file: {"path": "output.csv", "content": "data"}
- read_file: {"path": "input.txt"}
- replace_file: {"path": "file.txt", "old_text": "foo", "new_text": "bar"}

COMPLETION:
- done: {"text": "Final result/answer", "success": true}
</available_actions>

<efficiency>
Chain actions when it makes sense:
- input_text + click (fill form and submit)
- Multiple input_text (fill multiple fields)
- click + wait (click and wait for load)

Do NOT chain actions that change state unpredictably.
</efficiency>

<completion>
Call done action when:
- Task is fully completed (success: true)
- Task is impossible to complete (success: false)
- Maximum steps reached

Put ALL relevant findings in the done text field.
</completion>`;

export const THINKING_PROMPT = `
<reasoning_guidelines>
Before each action, reason through:
1. What is the current state? (URL, visible elements)
2. What did I try last? Did it work?
3. What should I do next to progress toward the goal?
4. Which element(s) do I need to interact with?
5. Am I stuck? Should I try a different approach?
</reasoning_guidelines>`;

/**
 * Build the full system prompt
 */
export function buildSystemPrompt(options?: {
  maxActionsPerStep?: number;
  extendMessage?: string;
}): string {
  let prompt = SYSTEM_PROMPT;

  if (options?.maxActionsPerStep) {
    prompt = prompt.replace(
      "1-3 actions maximum",
      `1-${options.maxActionsPerStep} actions maximum`
    );
  }

  prompt += THINKING_PROMPT;

  if (options?.extendMessage) {
    prompt += `\n\n<additional_instructions>\n${options.extendMessage}\n</additional_instructions>`;
  }

  return prompt;
}

/**
 * Build the user message with current state
 */
export function buildUserMessage(
  task: string,
  browserState: string,
  history: string,
  stepInfo: { current: number; max: number }
): string {
  return `<task>
${task}
</task>

<step_info>
Step ${stepInfo.current}/${stepInfo.max}
</step_info>

<history>
${history || "No previous actions."}
</history>

<browser_state>
${browserState}
</browser_state>

Respond with your next action(s) in JSON format.`;
}

/**
 * Parse the LLM response into structured output
 * Robust parsing with multiple fallback strategies
 */
export function parseAgentResponse(response: string): {
  thinking: string;
  evaluation_previous_goal: string;
  memory: string;
  next_goal: string;
  action: any[];
} | null {
  // Try multiple parsing strategies

  // Strategy 1: Direct JSON parse
  try {
    const parsed = JSON.parse(response.trim());
    if (isValidAgentOutput(parsed)) {
      return normalizeOutput(parsed);
    }
  } catch { /* continue to next strategy */ }

  // Strategy 2: Extract JSON object from markdown code block
  const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (isValidAgentOutput(parsed)) {
        return normalizeOutput(parsed);
      }
    } catch { /* continue to next strategy */ }
  }

  // Strategy 3: Find JSON object anywhere in response
  // Use a more robust regex that handles nested braces
  const jsonMatches = findJsonObjects(response);
  for (const jsonStr of jsonMatches) {
    try {
      const parsed = JSON.parse(jsonStr);
      if (isValidAgentOutput(parsed)) {
        return normalizeOutput(parsed);
      }
    } catch { /* try next match */ }
  }

  // Strategy 4: Try to repair common JSON issues
  const repaired = attemptJsonRepair(response);
  if (repaired) {
    try {
      const parsed = JSON.parse(repaired);
      if (isValidAgentOutput(parsed)) {
        return normalizeOutput(parsed);
      }
    } catch { /* failed */ }
  }

  return null;
}

/**
 * Check if parsed object has the required structure
 */
function isValidAgentOutput(obj: any): boolean {
  return (
    obj &&
    typeof obj === "object" &&
    (typeof obj.thinking === "string" || typeof obj.action !== "undefined")
  );
}

/**
 * Normalize the parsed output to ensure all fields exist
 */
function normalizeOutput(parsed: any): {
  thinking: string;
  evaluation_previous_goal: string;
  memory: string;
  next_goal: string;
  action: any[];
} {
  // Handle actions - could be array, object, or nested
  let actions: any[] = [];
  if (Array.isArray(parsed.action)) {
    actions = parsed.action;
  } else if (parsed.action && typeof parsed.action === "object") {
    actions = [parsed.action];
  } else if (Array.isArray(parsed.actions)) {
    actions = parsed.actions;
  } else if (parsed.actions && typeof parsed.actions === "object") {
    actions = [parsed.actions];
  }

  return {
    thinking: parsed.thinking || parsed.thought || "",
    evaluation_previous_goal: parsed.evaluation_previous_goal || parsed.evaluation || "",
    memory: parsed.memory || "",
    next_goal: parsed.next_goal || parsed.goal || "",
    action: actions.filter(Boolean),
  };
}

/**
 * Find all JSON objects in a string
 */
function findJsonObjects(text: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        results.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return results;
}

/**
 * Attempt to repair common JSON issues
 */
function attemptJsonRepair(text: string): string | null {
  // Find the first { and last }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
    return null;
  }

  let json = text.slice(firstBrace, lastBrace + 1);

  // Common repairs:
  // 1. Replace single quotes with double quotes (careful with contractions)
  json = json.replace(/(\w)'(\w)/g, "$1\\'$2"); // Protect contractions
  json = json.replace(/'/g, '"');
  json = json.replace(/\\'/g, "'"); // Restore contractions

  // 2. Add quotes to unquoted keys
  json = json.replace(/(\{|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

  // 3. Remove trailing commas
  json = json.replace(/,\s*([\]}])/g, "$1");

  // 4. Handle multiline strings (convert to escaped newlines)
  json = json.replace(/\n/g, "\\n");

  return json;
}
