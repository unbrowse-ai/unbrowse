# Generated Skills

Source design contract: [first-principles-skill-design](./first-principles-skill-design.md)
Refresh command: `bun skills/history-skill-miner/scripts/mine-history.ts`
History samples scanned: 1772

| Skill | Hits | Why it exists |
|---|---:|---|
| [docs-release-sync](../../docs-release-sync/SKILL.md) | 21 | keep the repo's user-facing narrative aligned with shipped behavior |
| [skill-surface-ship](../../skill-surface-ship/SKILL.md) | 17 | change the shipped skill surface without letting docs, package, and publish paths drift apart |
| [main-actions-triage](../../main-actions-triage/SKILL.md) | 5 | inspect `main` GitHub Actions truth and turn failures into concrete blockers |

## Evidence

### docs-release-sync
- can you put a guide no the frontend of how to set up restream? refer to the context7 docs to know how todo it properly
- git diff the past 3 days and come up with a massive changelog and then craft a tweet in human understnadbla lgnauge to post on X
- ok now write README.md use context7 to give proper mcp installatoin setup
- ok then update the readme using the alternative
- write a readme for this project, i dont know how to set it up
- clean up the repo of any secrets and pu ap roper readme

### skill-surface-ship
- unbrowse setup also isnt a command - you should just get people to npm i -g unbrowse@latest and npx skills add unbrowse-ai/unbrowse
- did it actualyl grab people? are you actually using the DAG in the marketplace kinda stuff?
- Add prefix-to-markdown skill install
- Fix marketplace skill publishing
- Fix frontend skill search limit
- Design shared skill architecture

### main-actions-triage
- Fix broken GitHub Actions
- Check deployment actions
- Check main blockers
- Check deployment on main
- check on whatever actions are running for main - are there blockers to resolve
