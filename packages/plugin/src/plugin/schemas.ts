// Tool schemas are kept in one file so each tool can be edited without hunting
// through the large plugin composition root.

export const LEARN_SCHEMA = {
  type: "object" as const,
  properties: {
    harPath: {
      type: "string" as const,
      description: "Path to a HAR file to parse",
    },
    harJson: {
      type: "string" as const,
      description: "Inline HAR JSON content (alternative to harPath)",
    },
    outputDir: {
      type: "string" as const,
      description: "Directory to save generated skill (default: ~/.openclaw/skills)",
    },
  },
  required: [] as string[],
};

export const CAPTURE_SCHEMA = {
  type: "object" as const,
  properties: {
    urls: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "URLs to visit and capture API traffic from. The tool launches a browser automatically — just provide URLs.",
    },
    outputDir: {
      type: "string" as const,
      description: "Directory to save generated skill (default: ~/.openclaw/skills)",
    },
    waitMs: {
      type: "number" as const,
      description: "How long to wait on each page for network activity in ms (default: 5000).",
    },
    crawl: {
      type: "boolean" as const,
      description: "Browse the site after loading seed URLs to discover more API endpoints. Follows same-domain links. (default: true)",
    },
    maxPages: {
      type: "number" as const,
      description: "Max pages to visit during crawl (default: 15). Only used when crawl=true.",
    },
    testEndpoints: {
      type: "boolean" as const,
      description: "Auto-test discovered GET endpoints with captured auth to verify they work (default: true).",
    },
    headless: {
      type: "boolean" as const,
      description: "Run browser in headless mode (default: false — browser is visible so you can interact if needed).",
    },
  },
  required: ["urls"],
};

export const AUTH_SCHEMA = {
  type: "object" as const,
  properties: {
    domain: {
      type: "string" as const,
      description: "Filter auth extraction to a specific domain",
    },
  },
  required: [] as string[],
};

export const REPLAY_SCHEMA = {
  type: "object" as const,
  properties: {
    service: {
      type: "string" as const,
      description: "Service name (skill directory name) to test",
    },
    endpoint: {
      type: "string" as const,
      description: "Specific endpoint to call (e.g., 'GET /api/v2/streams/trending'). If omitted, tests all endpoints.",
    },
    body: {
      type: "string" as const,
      description: "JSON body for POST/PUT/PATCH requests",
    },
    executionMode: {
      type: "string" as const,
      enum: ["browser", "node", "backend"],
      description:
        "Execution mode. browser/node = direct call (existing behavior). backend = call marketplace backend executor " +
        "to capture traces for LAM training (requires published skill + wallet).",
    },
    traceId: {
      type: "string" as const,
      description: "Optional traceId to group multiple endpoint calls into one sequence (backend mode).",
    },
    intent: {
      type: "string" as const,
      description: "Optional natural-language intent for this trace (backend mode). Stored in trace metadata.",
    },
    storeTrace: {
      type: "boolean" as const,
      description: "Whether to store workflow trace steps for LAM fine-tuning (backend mode, default: true).",
    },
    storeRaw: {
      type: "boolean" as const,
      description: "Whether to store raw request/response payloads (backend mode, default: false).",
    },
    autoChain: {
      type: "boolean" as const,
      description: "Auto-chain parentStepId to previous step in the same trace (backend mode, default: true).",
    },
    skillId: {
      type: "string" as const,
      description: "Marketplace skillId override (backend mode). If omitted, uses skillDir/marketplace.json.",
    },
    skillsDir: {
      type: "string" as const,
      description: "Skills directory (default: ~/.openclaw/skills)",
    },
  },
  required: ["service"],
};

export const SKILLS_SCHEMA = {
  type: "object" as const,
  properties: {},
  required: [] as string[],
};

export const PUBLISH_SCHEMA = {
  type: "object" as const,
  properties: {
    service: {
      type: "string" as const,
      description:
        "Service name (skill directory name) to publish to the cloud index. " +
        "Run publish from a delegated subagent.",
    },
    skillsDir: {
      type: "string" as const,
      description: "Skills directory (default: ~/.openclaw/skills)",
    },
    price: {
      type: "string" as const,
      description: "Price in USDC (e.g. '0' for free, '1.50' for $1.50). Default is free.",
    },
  },
  required: ["service"],
};

export const SEARCH_SCHEMA = {
  type: "object" as const,
  properties: {
    query: {
      type: "string" as const,
      description: "Search query — skill name, service, domain, or description",
    },
    install: {
      type: "string" as const,
      description: "Skill ID to download and install locally",
    },
  },
  required: [] as string[],
};

export const WALLET_SCHEMA = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      description:
        'Action: "status" (show wallet config + balances), "create" (generate a new Solana keypair), ' +
        '"set_creator" (use an existing wallet address for earnings), "set_payer" (set private key for paying downloads), ' +
        '"export" (reveal private key for backup - SECURITY: back up before funding!)',
    },
    wallet: {
      type: "string" as const,
      description: "Solana wallet address (for set_creator action - your existing wallet)",
    },
    privateKey: {
      type: "string" as const,
      description: "Base58-encoded Solana private key (for set_payer action)",
    },
  },
  required: [] as string[],
};

export const INTERACT_SCHEMA = {
  type: "object" as const,
  properties: {
    url: {
      type: "string" as const,
      description: "URL to navigate to. Uses authenticated session from a previously captured skill.",
    },
    service: {
      type: "string" as const,
      description: "Service name to load auth from (uses auth.json from this skill). Auto-detected from URL domain if omitted.",
    },
    skillMode: {
      type: "string" as const,
      enum: ["auto", "marketplace", "learn"],
      description:
        "Skill acquisition mode. auto = try marketplace first, otherwise learn on the fly. " +
        "marketplace = only use verified marketplace skills (no learning). " +
        "learn = skip marketplace and learn locally on the fly.",
    },
    actions: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            enum: [
              "click_element", "input_text", "select_option", "get_dropdown_options",
              "scroll", "send_keys", "wait", "extract_content",
              "go_to_url", "go_back", "done",
            ],
            description:
              "Action type. Use element indices from the page state (e.g. click_element index=3). " +
              "Index-based actions: click_element, input_text, select_option, get_dropdown_options. " +
              "Page actions: scroll, send_keys, wait, extract_content, go_to_url, go_back, done.",
          },
          index: {
            type: "number" as const,
            description: "Element index from page state (shown as [1], [2], etc.). Required for click_element, input_text, select_option, get_dropdown_options.",
          },
          text: {
            type: "string" as const,
            description: 'Text for input_text (value to type), select_option (option text to select), extract_content (query), send_keys (keys like "Enter", "Tab", "Control+a"), go_to_url (URL).',
          },
          clear: {
            type: "boolean" as const,
            description: "For input_text: clear existing text before typing (default: true).",
          },
          direction: {
            type: "string" as const,
            enum: ["down", "up"],
            description: 'Scroll direction (default: "down").',
          },
          amount: {
            type: "number" as const,
            description: "Scroll amount in pages (default: 1). Use 0.5 for half page, 10 for bottom/top.",
          },
          selector: {
            type: "string" as const,
            description: "CSS selector fallback — only use when element index is not available.",
          },
        },
        required: ["action"],
      },
      description:
        "Sequence of browser actions. After navigating, you receive a page state with indexed interactive elements " +
        "(e.g. [1] <button> Submit, [2] <input type=\"text\" placeholder=\"Search\">). " +
        "Reference elements by their index number in click_element, input_text, select_option actions.",
    },
    captureTraffic: {
      type: "boolean" as const,
      description: "Capture API traffic during interaction for skill generation (default: true)",
    },
    closeChromeIfNeeded: {
      type: "boolean" as const,
      description: "Only needed if Chrome is running WITHOUT remote debugging. If Chrome has CDP enabled (--remote-debugging-port), we connect directly without closing. Set true only if asked to close Chrome.",
    },
  },
  required: ["url", "actions"],
};

export const LOGIN_SCHEMA = {
  type: "object" as const,
  properties: {
    loginUrl: {
      type: "string" as const,
      description: "URL of the login page to navigate to",
    },
    service: {
      type: "string" as const,
      description: "Service name for the skill (auto-detected from domain if omitted)",
    },
    formFields: {
      type: "object" as const,
      description:
        'CSS selector → value pairs for form fields. e.g. {"#email": "user@example.com", "#password": "secret"}. ' +
        "Use CSS selectors that target the input elements.",
      additionalProperties: { type: "string" as const },
    },
    submitSelector: {
      type: "string" as const,
      description: 'CSS selector for the submit button (default: auto-detect). e.g. "button[type=submit]"',
    },
    headers: {
      type: "object" as const,
      description: "Headers to inject on all requests (e.g. API key auth). These are set before navigation.",
      additionalProperties: { type: "string" as const },
    },
    cookies: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const },
          value: { type: "string" as const },
          domain: { type: "string" as const },
        },
        required: ["name", "value", "domain"],
      },
      description: "Pre-set cookies to inject before navigating (e.g. existing session tokens)",
    },
    captureUrls: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "Additional URLs to visit after login to capture API traffic for skill generation",
    },
    autoFillFromProvider: {
      type: "boolean" as const,
      description:
        "Auto-fill login form using credentials from the configured credential source " +
        "(keychain, 1password, or vault). Only works if credentialSource is configured. Default: true when no formFields provided.",
    },
    saveCredentials: {
      type: "boolean" as const,
      description:
        "Save the login credentials to the vault after successful login (default: true if vault provider is active).",
    },
  },
  required: ["loginUrl"],
};

// ── Workflow Schemas ─────────────────────────────────────────────────────────-

export const WORKFLOW_RECORD_SCHEMA = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: ["start", "stop", "status", "annotate", "list"],
      description:
        'Recording action: "start" (begin recording), "stop" (finalize session), ' +
        '"status" (check if recording), "annotate" (add note to current step), "list" (show past recordings)',
    },
    intent: {
      type: "string" as const,
      description: "Description of what you're trying to accomplish (for start action)",
    },
    note: {
      type: "string" as const,
      description: "Annotation note (for annotate action)",
    },
    noteType: {
      type: "string" as const,
      enum: ["intent", "decision", "important", "skip"],
      description: 'Annotation type: "intent" (goal), "decision" (conditional), "important" (key step), "skip" (can omit)',
    },
  },
  required: ["action"],
};

export const WORKFLOW_LEARN_SCHEMA = {
  type: "object" as const,
  properties: {
    sessionId: {
      type: "string" as const,
      description: "Session ID to analyze and generate skill from",
    },
    outputDir: {
      type: "string" as const,
      description: "Directory to save generated skill (default: ~/.openclaw/skills)",
    },
  },
  required: ["sessionId"],
};

export const WORKFLOW_EXECUTE_SCHEMA = {
  type: "object" as const,
  properties: {
    skillName: {
      type: "string" as const,
      description: "Name of the workflow or api-package skill to execute",
    },
    inputs: {
      type: "object" as const,
      description: "Input parameters for the workflow (key-value pairs)",
      additionalProperties: true,
    },
    endpoint: {
      type: "string" as const,
      description: "For api-package skills: specific endpoint to call (e.g., 'GET /users')",
    },
    body: {
      type: "string" as const,
      description: "For api-package skills: JSON body for POST/PUT requests",
    },
  },
  required: ["skillName"],
};

export const WORKFLOW_STATS_SCHEMA = {
  type: "object" as const,
  properties: {
    skillName: {
      type: "string" as const,
      description: "Skill name to get stats for (omit for leaderboard)",
    },
    category: {
      type: "string" as const,
      enum: ["api-package", "workflow"],
      description: "Filter leaderboard by category",
    },
  },
  required: [] as string[],
};
