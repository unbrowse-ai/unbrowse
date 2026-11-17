# pip install "unbrowse[openai-agents]", then export UNBROWSE_NODE and UNBROWSE_AGENT_TOKEN from the Unbrowse app's
# agent key.
import os

from agents import Agent, Runner
from unbrowse.adapters.openai_agents import unbrowse_tools

extra = {}
if os.environ.get("UNBROWSE_STUB_MODEL"):  # a scripted model, calling no model API
    from stub import model

    extra["model"] = model

agent = Agent(name="HN reader", instructions="Answer questions about websites with the Unbrowse tools.", tools=unbrowse_tools(), **extra)
question = "What are the top Hacker News stories about Rust? https://hn.algolia.com/api/v1/search?query=rust answers it."
print(Runner.run_sync(agent, question).final_output)
