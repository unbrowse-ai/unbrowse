# pip install "unbrowse[langchain]" langchain langchain-openai, then export UNBROWSE_NODE and UNBROWSE_AGENT_TOKEN from
# the Unbrowse app's agent key.
import os

from langchain.agents import create_agent
from unbrowse.adapters.langchain import unbrowse_tools

if os.environ.get("UNBROWSE_STUB_MODEL"):  # a scripted model, calling no model API
    from stub import model
else:
    from langchain_openai import ChatOpenAI

    model = ChatOpenAI(model="gpt-5-mini")

agent = create_agent(model, tools=unbrowse_tools())
question = "What are the top Hacker News stories about Rust? https://hn.algolia.com/api/v1/search?query=rust answers it."
print(agent.invoke({"messages": [{"role": "user", "content": question}]})["messages"][-1].content)
