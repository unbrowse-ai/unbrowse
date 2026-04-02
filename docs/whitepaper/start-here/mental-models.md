# Mental Models

The old docs had strong analogies. The useful ones still hold, with a few updates.

## Search Engine for Actions

Google indexes information.

Unbrowse indexes reusable ways to get something done on the web.

That does not mean every route is precomputed forever. In the current product, it means:

* previously learned routes can be found from local cache or marketplace search
* if no good route exists, Unbrowse can capture and learn one
* successful learned routes can feed back into future reuse

So the product acts like an action index with live learning fallback.

## Private Highway, Not Public Transit

The old "executive and assistant" analogy still works.

Without Unbrowse, an agent often has to:

* walk through the visible UI
* wait on page loads
* adapt to layout friction
* guess where the real action sits

With Unbrowse, the agent can often take the shorter path:

* resolve intent against reusable skills
* execute the learned request path directly
* keep browser parity only when it is needed

The important update is this:

Unbrowse is not "no browser ever." It is "browser only where it adds real parity value."

## Cached Capability, Not Blind Replay

Another useful mental model:

Unbrowse is not just a request recorder.

It behaves more like a capability memory layer:

* capture learns candidate endpoints
* ranking decides which route to trust
* execution can adapt parameters
* feedback and verification affect what stays hot

That is more faithful to the current repo than the older docs' simpler "record once, replay forever" framing.

## Paper Vision vs Product Reality

The old docs sometimes implied a fuller network economy than what ships today.

The current grounded split is:

* capability layer: real
* marketplace reuse: real
* eval and verification layer: real, though simpler than the paper's full trust model
* route economy and payout layer: `coming soon`

## Read Next

* [What Is Unbrowse?](what-is-unbrowse.md)
* [How It Works](how-it-works.md)
* [Coming Soon](../reference/coming-soon.md)
