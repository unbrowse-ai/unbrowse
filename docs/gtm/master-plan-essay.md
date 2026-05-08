# The Foundry Master Plan

### Own every layer. Or rent forever.

If you are anything like me, you have watched a hundred agent demos and bought zero of them.

You sit there. You nod. You bookmark the tweet. You maybe even fork the repo. A week later you are back to writing the same Cursor autocomplete you wrote in 2024, because the demo was a magic trick and the trick does not survive contact with your actual workday. I have done this. I have shipped this. I have watched my own demos work in the studio and fall over the second a real user touched them.

The honest version is that the agent era has not started yet. We are still in the demo era. The infrastructure that would let an agent be useful, cheap, accessible to a non-developer, and actually trustworthy, does not exist. Nobody has built it. The companies you think have built it are running on a subsidy you cannot see.

This is not one of those threads you scroll past. Bookmark it, take notes on it, sit with it. If you are building anything in this space, the next twelve months will separate the people who understood what was real from the people who were riding a balance sheet.

Here is the spine of the whole argument before I bury it under examples: *every agent company you admire is a tenant.* They lease their inference. They lease their runtime. They lease their web access. They lease their users' data back from the vendor that stores it. The category looks like a market because the rent is being paid by someone else this quarter. The day that stops, the category implodes back to whoever owns the layers underneath.

Foundry is the bet that the next category-defining agent company is a *freeholder.* Owns its model. Owns its kernel. Owns its execution path to the open web. Owns the runway that funds all three. Lets the user own the only thing that actually matters to the user, which is their context, their data, their machine. *Sovereignty at every layer.* Each section of this essay is one stone in that wall.

Seven ideas you probably have not heard put together this exact way before. What we learned building Foundry, the four problems we kept hitting, the four-layer stack we are betting the studio on, why our wager on Unbrowse as the agentic internet's execution surface is not optional, and why the next category-defining agent will not look like an agent at all.

Let us begin.

## I – Every Agent Demo You Have Ever Loved Is Being Paid For By Anthropic

I posted this on April 28th and it did not go viral, but it should have:

> *"setting up proper agentic orchestration costs thousands of Opus tokens a day to achieve decent accuracy, and that's subsidised by the Anthropic! did you know that SOTA model providers are still making a loss on every api call you make to their models?"*

Read it twice. The agent loop you saw on the timeline last night, the one that booked a flight or refactored a repo or scraped a competitor, ran on inference the provider sold you below cost. The economics are not real yet. They are a venture-funded pre-launch price.

This is fine for a demo. It is catastrophic for a product. The day a model provider raises rates, or rate-limits your tier, or quietly nerfs the model behind your wrapper, your beautiful agent stack has the resilience of a sand castle at high tide.

Borrow a concept from physics: *entropy.* A closed system trends toward disorder unless energy is poured in continuously. Your agent stack is a closed system. The energy keeping it ordered, working, accurate, is being poured in by someone else's treasury. The day they stop, your accuracy collapses to mean.

Most founders building on top of frontier models have not modeled this. They think they have a product. They have a lease.

The deeper problem is not even the price. It is that the price hides the architecture. When tokens feel free, you write loops that burn fifty thousand of them on a task that should have cost two hundred. You pile reasoning on reasoning, you stack reflection passes, you let the agent re-read the same page nine times. The subsidy makes you lazy.

Laziness in agent design is not a vibe. It is structural debt that comes due the second your unit economics see daylight.

> *"In the long run, the system that depends on a subsidy is governed by whoever pays the subsidy."* (Chris Paik)

So the first question, before anything else: *who is paying for your inference, and what happens when they stop.*

## II – Cost Is The Boring Problem. Accessibility And Usability Are The Ones That Will Embarrass You.

Cost gets all the airtime because it is measurable. The other two are quieter, and more lethal.

**Accessibility.** Today's agents are operated by developers, for developers, on the developer's terminal. To use Claude Code you need a CLI, a GitHub account, an API key, and the willingness to read a stack trace. My mother is smart. My mother is not going to install Homebrew. The total addressable market of agents-as-they-exist is roughly the population of people who already write code, which is a rounding error against the population of people who have problems an agent could solve.

The whole category got the shape wrong. Every "AI agent" today is really a kit for building one. Clone the repo. Paste the API keys. Install MCPs, CLIs, Skills. When one bug hits, the whole session is gone. Regular people do not want to build an agent. They just want the work done.

*The problem was never AI. The problem was making normal people become developers first.*

**Usability.** Even when a developer can run an agent, can they trust it. Can they hand it a real task and walk away.

The honest answer right now is no. You hover. You watch the token meter. You kill the run when it spirals. You get the stray cron at 2am that DMs your girlfriend something hallucinated. You laugh, you screenshot it, you post it, you do not actually let the thing run unsupervised on anything that matters. (Looking at you, agent-platform-of-the-week founders, who keep promising autonomy you would not give to your own todo list.)

A bodybuilder does not become a bodybuilder by spending six hours a day correcting his squat form. He becomes a bodybuilder because the squat became automatic and his attention moved to the next thing. A CEO does not become a CEO by personally writing every email.

The agent equivalent has not happened. The trust gradient has not been climbed. We are still at the squat-correction stage with infrastructure that costs thousands of dollars a day to keep upright.

> *"What you can do, or dream you can, begin it."* (W. H. Murray, often misattributed to Goethe.)

The three problems compound. Cost gates accessibility. Accessibility gates usability. Usability gates trust. Trust gates the actual market. You cannot fix one without fixing all three, which is why one-feature startups in this space keep stalling at the same revenue ceiling, then quietly pivot to "AI for sales teams" six months later.

## III – The Master Plan Is A Stack, Not A Roadmap

There are a few moments in my life I remember vividly. They always follow the same pattern.

I built a thing on top of someone else's stack. The someone changed a setting. My thing broke in front of a paying user.

The first time it was a Twitter API tier change. The second time it was an OAuth scope tightening. The third time it was a model provider quietly halving my rate limit between Friday afternoon and Monday morning. After the third one I stopped calling it bad luck and started calling it the cost of leasing. *If your stack is rented, the landlord owns your roadmap.*

So roadmaps are linear, and stacks are recursive: each layer subsidises the one above it, and the bottom layer pays for the whole thing. The four layers in our master plan map onto four leases the rest of the industry is paying. Each layer is what we own *instead of* renting. Bottom to top:

**Layer 1 — runway sovereignty (Foundry Vault).** *Stop renting your runway from the next funding cycle.* Every other layer is expensive and takes time. If your runway depends on the same VC cycle that demands hockey-stick revenue in eighteen months, you cannot build the boring infrastructure the agent era actually needs. The Vault is patient capital with a public on-chain ledger. Studio revenue market-buys FDRY, bought-back FDRY goes into the Vault, the Vault compounds. This is not romantic. It is balance-sheet design. The Vault is what lets the studio say no to the thing the market wants this quarter and yes to the thing the market needs in 2027.

**Layer 2 — model sovereignty (Aiko).** *Stop renting your model from someone else's loss-leader.* You cannot own your agent if you do not own (or at least not-rent) the model. Aiko is built on the Qwen base, tuned in-house for the agentic and coding loops our stack actually runs. The point is not to beat GPT-5 on every benchmark. The point is to control the weights, the cost, and the behavior of the thing your loop depends on. Small enough to run on a laptop. Tuned closely enough to be useful where it matters. Free enough at the Aiko Code layer that the trust gradient becomes climbable. Aiko is *she* when we talk about her, because the product is a person you delegate to, not a panel you configure.

**Layer 3 — runtime sovereignty (Agent OS).** *Stop renting your kernel from someone else's framework.* Today's agent frameworks are libraries pretending to be operating systems. They orchestrate, sort of. They handle retries, sometimes. They give you observability, if you bolt on five other tools. An Agent OS, properly built, is the kernel that makes Layer 2 cheap and Layer 4 trustworthy: a local runtime, a typed cell protocol, capability-bounded skills, polyglot cells on one nervous system. Most teams skip this layer because writing a kernel is the worst possible market timing for a seed round. We are writing the kernel.

**Layer 4 — execution sovereignty (Unbrowse).** *Stop renting your web access from a headless-browser proxy farm.* This is the layer most builders miss, and the one we are betting the most studio time on. Every agent does the same thing, constantly: it reaches out to the web. Searches. Scrapes. Hits APIs. Logs into dashboards. Today it does this through a brittle pile of headless browsers that cost a small fortune in CPU and rotate through proxies like a getaway driver. The northstar is one sentence: *agent gives URL plus intent; Unbrowse picks cheapest correct path (cache → graph → browser).* If you own the cheapest correct path between an agent and the open web, you own the rate-limiting reagent of the whole industry.

Plus the layer none of the others can serve without: **user sovereignty.** *The user stops renting their data back from the vendor that stored it.* Aiko runs on the user's machine, on the user's context, with the user's IP and cookies on every web call. Personalization is a property of the architecture, not a setting in a panel. The data does not leave the foundry walls.

Borrow a concept from cybernetics, specifically Norbert Wiener's closed-loop control. A system that takes an action and never measures the result is not in control of anything. A system that takes an action, measures the outcome against the intent, and adjusts, is.

The four layers form one loop: the Vault funds the model, the model trains in the OS, the OS executes through Unbrowse, and the traces from every Unbrowse call feed back into both the model's training data and the OS's planner. Every layer is the sensor and the actuator for the layer next to it.

This is why a roadmap will not get you there. Roadmaps assume one thing finishes before the next begins. A stack assumes everything is alive at once and feeding the others.

Anyone who tells you they will build "the agent" without building all four layers is going to discover, in production, that they built one quarter of a system and called it whole. (And then pivot to "AI for sales teams" six months later, because c'mon.)

> *"The purpose of a system is what it does."* (Stafford Beer)

If your agent system, in production, ships demos, then it is a demo company. If every cycle makes the next one cheaper, it is something else.

## IV – Aiko Is The Agent. There Is Nothing To Build.

We released Aiko v1 yesterday. Same day as that thread. Built on Qwen, with an agentic and coding tune we did in-house, shipped alongside Aiko Code, an OpenClaw fork that is free, open-source, and runs locally.

Two URLs. Save them.

- aiko.getfoundry.app
- github.com/getfoundry/aiko-code

The model is not the product. The wedge is.

*You do not build an agent. You describe what you need.*

You download a `.dmg`. You say "send me a competitor report every Monday." It happens. The next Monday it happens again. You did not write a workflow. You did not paste an API key. You did not pick a tool. You said the sentence. She did the thing.

This sounds like marketing. It is actually an architecture claim. The reason every other agent product asks you to build the agent first is that they did not ship the runtime. They shipped a kit. The model lives somewhere else. The tools live somewhere else. The memory lives somewhere else, if at all. You are the integrator.

With Aiko, the agent, the tools, the memory, and Unbrowse all live inside the app. No MCP. No CLI. No keys. The workflow is a recording of work she watched you do once, generalized into a cell she can replay. *Workflows are not edited. Workflows are remembered.*

Now think about what local actually unlocks. Aiko mines the context already on your machine: your browser history, your calendar, your open tabs, the docs you have been editing, the apps you keep coming back to. She does not ask you to upload anything. She does not need to. The context is already there. She remembers across sessions, so the second time you ask for the Monday report, she does not start from zero. She also learns from your actual reactions: the sentence you rewrote, the source you removed, the tone you nudged warmer. *Personalization is not a setting in a panel. It is what happens when an agent runs where the work happens.*

Other agents cannot do this honestly because the model lives somewhere else. To personalize, they have to ship your data out. To remember, they have to store your data on their servers. To "learn your style," they have to train on your work in their tenant. None of those sentences end with "and your data stays yours." With Aiko, all three end exactly there.

Borrow a concept from neuroscience: the *salience network.* The part of your brain that decides which of the thousands of signals competing for your attention deserves the spotlight.

Founders right now have salience networks that have been hijacked by the loudest model release. New Opus drops, you switch. New Sonnet drops, you switch. New open weights drop, you spin up a benchmark and lose a weekend. Meanwhile your actual product still does not work, because you optimised for the model and not the loop.

The lesson, learned painfully, is that the right model for production is the smallest one that fits the loop reliably. Not the loudest one. Not the smartest one in absolute terms. The one whose cost, latency, and behavior fit your closed loop without tipping it over.

Aiko is that, for our stack. She is also small enough to live on the user's machine, which is the only honest answer to "where does my data go." It does not go anywhere. *The agent is local. Personalization is local. The moat is local.*

I have eaten the same lesson a dozen times: build a thing, watch a non-technical person try to use it, watch them give up before the second screen. The version of Aiko that survives the test is the version where the user describes and the system recovers. Sarah is a marketing manager. Not a developer. Tried four agent tools. Each one asked her to wire something. She gave up and went back to ChatGPT as a chatbot. With Aiko, she described her Monday competitor report once. It has landed in her inbox on time every Monday since. She did not build anything. She just described it.

The total addressable market of "people like Sarah" is most of the people who currently pay for AI and only use it as a search box. (Hell, I would even argue that is most of the people who *will ever* pay for AI.)

> *"Strong opinions, loosely held, are how you survive a fast-moving field."* (Naval)

The benchmark write-up is coming. The point of releasing v1 was to put a stake in the ground: we are not just talking about a stack, we are shipping it.

## V – Unbrowse Is The Cathedral. The Operator Stack Compounds. The Demo Stack Resets.

Demo stacks optimise for the highlight reel. Operator stacks optimise for the receipt. Unbrowse is the operator stack for the open web, and it is the layer the rest of the master plan rests on.

We dropped the whitepaper on April 1st: *Internal APIs Are All You Need: Shadow APIs, Shared Discovery, and the Case Against Browser-First Agent Architectures.* arXiv 2604.00694. Tham, Garcia, Hahn. The thesis is one sentence: every website you want to scrape already has an API behind the UI, and the cheapest correct path is to learn it once and share the learning. The benchmark spans 94 domains. The numbers we cared about were not "look at this cool agent." They were the boring ones: cached API execution averaged *950ms* against *3,404ms* for browser automation, a *3.6× mean speedup, 5.4× median.* Well-cached routes returned in under *100ms.* Cold-start tail in the worst case touched *8,200ms.* And every single answer came back with a composite score we computed in-house — *40/30/15/15* across freshness, accuracy, coverage, and cost. None of those numbers will get retweeted. All of them are the difference between a thing you can sell and a thing you can post.

Why do those numbers exist. Because we measured them. Because the system was designed, from day one, to produce a trace for every action it takes. An agent fires a request. Unbrowse picks the cheapest correct path through three tiers (local cache, shared graph, browser fall-through). The result comes back with a structured receipt: which path was used, how long it took, what the cache state was, what it would have cost on the slow path, what the freshness window of the cached answer was. *Every action leaves a paper trail. The paper trail is the product.*

Demo stacks do not produce receipts because receipts are embarrassing. They show you the eight retries the agent needed before it got the right page. They show you the 47-second tail latency on the request the demo conveniently skipped. They show you the rate-limit error your headless browser ate silently. The reason demo agents look magical is the same reason demo magicians do: the misses are off-screen.

Borrow a concept from chemistry: *autocatalysis.* An autocatalytic reaction produces its own catalyst. The product of one reaction makes the next reaction faster. Most reactions slow as reactants deplete. Autocatalytic ones accelerate as they run.

Our stack is autocatalytic. Every request Aiko makes through Unbrowse is also a brick in the route graph. Every successful cache hit is evidence the route is stable. Every browser fall-through that finds a hidden API is a discovered endpoint future agents will not have to discover. *Day-one Aiko is a worse product than day-one-thousand Aiko, automatically, with nobody pushing a button.*

This is not a thought experiment. The meter is on. As of today: **1,044 agents** are routing through Unbrowse. The shared graph is at **23 skills, 196 endpoints, 23 domains, 10,912 resolves**, and a **44% marketplace hit rate**, which means almost half of every request is now answered by a route someone else already paid the cold-start tax for. Cumulative: **177M tokens saved, 59% average time saved, 54% average tokens saved per resolve.** Developer side: **26,174 npm downloads, 6,714 in the last week alone, 89 active keys, 647 GitHub stars.** None of those numbers will get retweeted. All of them are the difference between a cathedral I drew and a cathedral I am pouring concrete on.

Worth being precise about what "local" means at the Unbrowse layer too, because it is the same architectural commitment Aiko makes at the model layer. When Aiko makes a web call, the request does not detour through a central proxy farm in some datacenter. It goes from your machine, your IP, your session, your cookies, directly to the target site. *The route graph is shared. The execution is not.* That distinction matters for three reasons. *One*, your agent inherits your trust budget. Sites do not rate-limit you the way they rate-limit a known headless-browser cluster, because as far as the site is concerned, you are still you. *Two*, your data does not leave your machine on the way out either, not just on the way back. *Three*, the unit economics finally work, because nobody is paying CPU bills for your scraping in a datacenter you do not own.

Local model. Local context. Local execution. The route graph is the only thing that is shared, and that is on purpose. This is also why personalization is honest in our stack and theatre in everyone else's: an agent that does not ship your data anywhere can afford to actually know you, because nobody else is going to see what it learned.

Borrow another concept from network economics: *Metcalfe-style scaling.* The value of a network grows with the square of its nodes, not linearly. Most agent companies have no network. Each customer is an isolated deployment. They can charge for the work, they cannot charge for the connection.

We are building the connection layer. The work is local: Aiko on your machine, your context, your data. The connection is shared: Unbrowse, one route graph, one meter. *Local work plus shared connection* is the shape of every durable consumer-meets-utility business of the last thirty years.

The whitepaper proposes a three-tier x402 micropayment to make participation voluntary and self-correcting: an agent only pays the next tier when the fee is lower than the cost of rediscovering the route in a browser. The graph grows because it is cheaper to contribute than to reinvent. Once it grows, it is cheaper to use than to compete with.

This is not a SaaS. It is a public utility with a meter, and the meter is the moat. The graph is denser the more agents use it. The more agents use it, the cheaper it is to use. The cheaper it is to use, the more agents come. That loop has exactly one steady state: *everyone routes through it.*

The right frame is *compounding stack beats memoryless stack.* Demos are memoryless by design. Every demo starts fresh because that is the only way the demo can be reproduced. Operators have memory because that is the only way they get cheaper. Day one of an operator stack looks indistinguishable from a demo. Day six hundred is something a demo can no longer compete with at any price.

> *"Compound interest is the eighth wonder of the world. He who understands it, earns it; he who does not, pays it."* (Attributed to Einstein, probably apocryphal, true anyway.)

## VI – The Studio Is The Product. The Token Is The Index.

Most agent companies are one product. We are not.

I have quit ten times more goals than I have achieved, and the one lesson that survived all of them: if you only have one shot, you optimize for the shot and not the aim. The thing we are building is a studio whose output is indexed by a single token, FDRY, and whose runway is funded by the Vault that token feeds.

Every product the studio ships, Unbrowse, Aiko, the Agent OS, the next thing, market-buys FDRY on-chain. The bought-back FDRY does not get burned, it gets deposited into the FDRY Vault. Studio cashflow times algo edge equals stacked exposure. Outsiders deposit on the same terms the studio does. If you think the algo works, you levered yourself onto it. If you think the studio works, you hold FDRY. If you think both, you do both.

The numbers, since you asked. Walk-forward Sharpe of *+1.212.* Max drawdown *-9.98%.* *97-day* k-fold-gated holdout. Daily rebalance, fail-closed. Initial deposit cap *$500k AUM*, not as a marketing softener but as the honest boundary at which the validated edge survives slippage.

Borrow a concept from the philosophy of science: *falsifiability.* A claim that cannot be wrong is not a claim, it is a vibe. Most quant pitches are vibes dressed in charts. Ours has a public log of the things we tried and rejected, and the rejections are louder than the acceptances. The strong cross-domain-scorer thesis: rejected three independent ways. Universe expansion past the validated set: rejected. The signal as a forecaster instead of a tiebreaker: rejected, after the offline backtest showed equal-weight beat the headline strategy at 40bps. We baked the equal-weight fallback into v1 because of that finding, not in spite of it. *The retracted-hypothesis log is the credibility. The accepted hypotheses are just what survived.*

This is not a story about crypto. It is a story about why the master plan can survive the next two years even if every layer is unprofitable on its own timeline. Layer 1 funds Layer 2. Layer 2 makes Layer 3 cheap enough to ship. Layer 3 makes Layer 4 trustworthy enough to scale. Layer 4 routes the agentic internet through one cache, and the cache feeds revenue back into Layer 1.

Any one layer in isolation is a venture pitch. All four together, with a public on-chain ledger of buybacks, is a thesis you can audit.

I am repeating the caveats because the most important ideas deserve to be repeated. The deposit cap is small. Round-trip economics at today's pool depth are net-negative in FDRY terms. v1 is positioned as an experimental alpha product and public track record, not a profit product. State that in every depositor pitch. (Looking at you, anonymous DeFi accounts who think honesty is bearish.)

The point is not "buy the token." The point is *the studio's incentives are visible on-chain.* There is no founder discretion in the value-routing path. Either the products ship and the buybacks are real, or they do not and they are not. You can check.

> *"What gets measured gets managed."* (Peter Drucker)

## VII – The Master Plan, Five Lines

Tesla's first master plan was four lines. Build a sports car. Use that money to build an affordable car. Use that money to build an even more affordable car. While doing all that, ship solar.

Ours is five.

**1. Run the FDRY Vault.** Public on-chain ledger of buybacks, daily rebalance, fail-closed. Initial deposit cap *$500k AUM*, lifted only on validated triggers. Patient capital that lets the studio say no to the wrong quarter and yes to the right decade. This is the runway nobody else owns.

**2. Train and ship Aiko.** v1 is out. Qwen base, agentic and coding tune in-house, paired with Aiko Code (free, open-source, OpenClaw fork). v1.x ships the public benchmark, the .dmg installers for both desktops, and the workflow-by-description wedge that lets a non-developer complete a real task end-to-end without a CLI. Free local tier forever. Hosted enterprise tier for teams. The agent runs on your machine; the data never leaves.

**3. Build the Agent OS.** Local runtime, typed cell protocol, capability-bounded skills, polyglot cells on one nervous system. Kernel-first, framework-never. Aiko runs on it natively. The protocol is published so other agents can route through it and so the cells you build do not become orphans the day a vendor pivots.

**4. Scale Unbrowse to the agentic internet's execution layer.** Today's meter: *1,044 agents, 196 endpoints, 23 domains, 44% marketplace hit rate, 177M tokens saved.* Cathedral target: *10,000 endpoints across 1,000 domains, 70% hit rate, p50 sub-500ms warm cache, three-tier x402 micropayment live for shared-graph contributions.* Local routing through the user's IP, not a proxy farm. The meter is the moat.

**5. Keep the receipts public.** Every product's traction live at api.unbrowse.ai. Every Vault buyback on-chain. Every retracted hypothesis logged. The flywheel is the company; the ledger is the proof; the proof is what makes Foundry worth more than the sum of its products.

That is the whole thing. Five lines. We will ship them in this order, on this stack, for the reasons in Sections I through VI.

How did we get to those five? We ran an audit on ourselves before we wrote any of this down. Five questions, each one mapped to a layer and to a lease the rest of the industry is paying. We are publishing the audit because if you are reading this as a builder rather than a depositor or a customer, the same questions apply to your stack too.

### The five-layer audit (run on Foundry, run on yours)

**1) Who is paying for your inference, and what happens when they stop.** If your unit economics depend on a frontier provider's loss-leader pricing, you do not have unit economics, you have a forward-dated invoice. Map the path from *user does the thing* to *we pay for tokens* to *we get paid by the user.* If the second number is bigger than the third and the only plan is "they will lower prices," that is an arbitrage on someone else's strategy, not a company.

**2) Can a non-developer complete a real task, end to end, without a CLI.** Not the investor. Not the iOS friend. An actual normal user with an actual normal problem. If they install anything, copy any key, paste any token, or read any error message, the product is still in the developer-tools market. Which is fine. Just be honest about which market that is. The agent market, properly defined, starts at the line where my mother can complete a task.

**3) Does the system get cheaper the more it runs.** A thousand identical requests should not cost a thousand times the price of one. Find the layer that compounds. Cache the routes. Reuse the cells. Share the graph. *If nothing in your architecture gets cheaper or smarter with use, your moat is your runway, and runway is not a moat.*

**4) If your model provider changes policy tomorrow, do you still ship.** Run the thought experiment. Tonight, your primary provider triples prices, halves rate limits, and quietly nerfs the model. What happens on Friday morning. If the answer is "we have a fallback," good, test the fallback today. If the answer is "we are cooked," you are one press release away from being cooked.

**5) When the agent reaches out to the web, what is the cheapest correct path.** Most teams have not asked this. Their agent opens a headless browser for everything, including the API call that would have answered in 200ms. For every external action your agent takes, write down: cache hit, route-graph hit, browser fall-through. If your default path is browser, you are paying ten times what the answer is worth. *The cheapest correct path is the only path that scales.*

Foundry's answer to all five is in Sections I through VI. Yours is yours.

> *"The best time to plant a tree was twenty years ago. The second best time is now."*

The demo era was the rental era. Models rented from one provider. Runtimes rented from one framework. Web access rented from one proxy farm. Runways rented from one funding cycle. User data rented back to the user from the tenant that stored it. The whole stack a sublease, paid for this quarter by someone else's burn.

The Foundry era is the freehold era. We own the model. We own the kernel. We own the path to the open web. We own the runway. The user owns everything that was always theirs in the first place.

Nothing has actually changed about what mattered. We are finally just naming it. The companies that survive the next two years will be the ones who built the flywheels under the magic, the kernels under the demos, the network effects under the screenshots. The flashy stuff was always going to commoditize. The owned layers were always going to be the moat.

We are building the boring stuff. We are paying for our own inference. We are letting the user describe instead of making them build. Our stack will get cheaper while we sleep, or we will not have a stack worth running.

*Own every layer. Or rent forever.*

– Lewis
