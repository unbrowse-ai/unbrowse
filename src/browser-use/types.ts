/**
 * Browser-Use TypeScript Port - Type Definitions
 *
 * Core types for the browser automation agent.
 */

export interface BrowserState {
  url: string;
  title: string;
  tabs: TabInfo[];
  interactiveElements: InteractiveElement[];
  scrollPosition: { x: number; y: number };
  scrollHeight: number;
  viewportHeight: number;
}

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

export interface InteractiveElement {
  index: number;
  tagName: string;
  role?: string;
  text: string;
  ariaLabel?: string;
  placeholder?: string;
  href?: string;
  type?: string;
  isNew?: boolean;
  selector: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
}

export interface AgentState {
  thinking: string;
  evaluationPreviousGoal: string;
  memory: string;
  nextGoal: string;
}

export interface AgentOutput {
  thinking: string;
  evaluation_previous_goal: string;
  memory: string;
  next_goal: string;
  action: ActionModel[];
}

export type ActionModel =
  // Navigation & Browser Control
  | { navigate: { url: string; new_tab?: boolean } }
  | { search: { query: string; engine?: "duckduckgo" | "google" | "bing" } }
  | { go_back: {} }
  | { wait: { seconds?: number } }

  // Element Interaction
  | { click: { index: number; coordinate_x?: number; coordinate_y?: number } }
  | { input_text: { index: number; text: string; press_enter?: boolean; clear?: boolean } }
  | { scroll: { direction: "up" | "down"; amount?: number; pages?: number; index?: number } }
  | { scroll_to_text: { text: string } }
  | { send_keys: { keys: string } }
  | { upload_file: { index: number; path: string } }

  // Form Controls
  | { dropdown_options: { index: number } }
  | { select_dropdown: { index: number; text: string } }

  // Tab Management
  | { switch_tab: { tab_id: number | string } }
  | { close_tab: { tab_id?: number | string } }

  // Content Extraction
  | { extract: { query: string; extract_links?: boolean } }
  | { screenshot: { full_page?: boolean } }

  // JavaScript Execution
  | { evaluate: { code: string; variables?: Record<string, any> } }

  // File Operations
  | { write_file: { path: string; content: string } }
  | { read_file: { path: string } }
  | { replace_file: { path: string; old_text: string; new_text: string } }

  // Task Completion
  | { done: { text: string; success: boolean; files_to_display?: string[] } };

export interface ActionResult {
  success: boolean;
  extractedContent?: string;
  error?: string;
  includeInMemory?: boolean;
}

export interface AgentHistory {
  step: number;
  state: AgentState;
  browserState: BrowserState;
  actions: ActionModel[];
  results: ActionResult[];
  timestamp: Date;
}

export interface AgentHistoryList {
  history: AgentHistory[];
  finalResult?: string;
  success: boolean;
}

export interface AgentConfig {
  task: string;
  startUrl?: string;
  maxSteps?: number;
  maxActionsPerStep?: number;
  useVision?: boolean;
  sensitiveData?: Record<string, string>;
  extendSystemMessage?: string;
}

export interface BrowserConfig {
  headless?: boolean;
  executablePath?: string;
  userDataDir?: string;
  profileDirectory?: string;
  viewport?: { width: number; height: number };
  /** Browser-Use API key for cloud browser fallback */
  browserUseApiKey?: string;
  /** Force cloud browser even if local is available */
  forceCloud?: boolean;
  /** Proxy country code for cloud browser (e.g., "US", "GB") */
  proxyCountry?: string;
}

export interface CapturedRequest {
  method: string;
  url: string;
  status: number;
  resourceType: string;
  headers?: Record<string, string>;
  postData?: string;
  responseHeaders?: Record<string, string>;
}
