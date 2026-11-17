# Framework quickstarts

Each folder is one agent framework's quickstart, under 20 lines, asking a real question through `unbrowse_do`:

| Folder | TypeScript | Python |
|---|---|---|
| [ai-sdk](ai-sdk) | `index.mjs` (Vercel AI SDK) | |
| [langchain](langchain) | `index.mjs` | `main.py` |
| [mastra](mastra) | `index.mjs` | |
| [openai-agents](openai-agents) | `index.mjs` | `main.py` |

Run one against the node on your machine, with the setup the Unbrowse app shows when it makes an agent key:

```bash
export UNBROWSE_NODE=http://127.0.0.1:7788 UNBROWSE_AGENT_TOKEN="$(unbrowse agent token)"
cd ai-sdk && npm install && OPENAI_API_KEY=<key> npm start
cd langchain && pip install -r requirements.txt && OPENAI_API_KEY=<key> python main.py
```

`UNBROWSE_STUB_MODEL=1` (`npm run stub`) swaps the model for a scripted one in `stub.mjs` or `stub.py`: it calls
`unbrowse_do` once and answers from the JSON the node sends back, so the tool call reaches your node and no model API
is called. The packages install this repository's SDK (`file:../../typescript`, `../../python`); in your own project,
install `unbrowse` from the registry instead.
