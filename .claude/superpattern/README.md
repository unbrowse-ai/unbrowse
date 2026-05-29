# .claude/superpattern/ — pointer into the /superpattern skill (no baked copies)

The planner and tool maps are AGNOSTIC and live ONCE in the skill:
  - planner:        ~/.claude/skills/superpattern/scripts/plan.py
  - framework maps: ~/.claude/skills/superpattern/references/frameworks/<fw>.tools.json
  - tool->verb/atom: pick a framework (claude, graff, ...) by pointer, not payload

This dir holds ONLY this project's problem graph(s). To (re)plan:

    python3 ~/.claude/skills/superpattern/scripts/plan.py \
        .claude/superpattern/exa.graph.json --framework claude --target CLAUDE.md > CLAUDE.md

Swap --framework (or the graph's "framework" field) to retarget the SAME graph
to graff or any other framework. List frameworks:

    python3 ~/.claude/skills/superpattern/scripts/plan.py --frameworks
