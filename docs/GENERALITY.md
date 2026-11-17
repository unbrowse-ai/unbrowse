# Generality: the rule behind every fix the Eden report asked for

The report is not a list of ten bugs. It is one bug in ten costumes: **the node treated a site's shape as code**.
A page was read as one JSON document, a query value as a constant, an answer as whatever arrived, a door as one site's
special case. Each fix is the same move — *read the walk, do not know the site* — and each one ships with a gate so the
class cannot come back as a site-shaped special case.

This page is the ledger. `crates/learn/tests/engine_is_general.rs` enforces it: the static checks run there, and the
test fails if a gate named below is removed.

## The rules

1. **The engine knows no site.** A route is learned data: a page, its scripts, a jar, a graph of steps. No host literal,
   no `match host { "x.com" => … }`, no "if this is Lazada". Site knowledge lives in the walk (the route, the page, the
   scripts, the jar) and nowhere else.
2. **Every value the caller can change is an input**, however short (`adults=2`), and **every placeholder a route sends
   is filled by one** (`q={q}` with `inputs: []` is not a route).
3. **A call is a candidate however it is sent**: JSON, events of JSON (`text/event-stream`), a page's embedded state, a
   script-safe prefix, text the site serves as data.
4. **A page carries more than one document.** A value is looked for in all of them, in page order, not the first or the
   biggest.
5. **An absent value is only fatal where the request needs it.** Where the request's own template holds `null`, the call
   goes out with the null; where the template holds a real value, the step fails rather than making a request the site
   never answered.
6. **The request the page makes is the request that goes out** (signed routes): its address, body and signature travel
   together, and a header the page set replaces the route's own value of the same name.
7. **A call the page does not make is skipped only when nothing later reads its answer.** One a later step reads from is
   not optional: it goes to the browser, or the call fails.
8. **Meet a door with whatever satisfies it.** A refusal is answered by asking again in a window (and letting a
   challenge clear), by carrying the browser's own shape, or by solving the challenge. Whatever satisfies it must stay a
   property of the walk: never a branch on the site's name, and never a success the site did not give.
9. **Any fix ships with a test over a synthesized trace** (fixtures are `*.example`), named in the ledger. A test that
   would pass without the fix is not a gate.

## The classes, and what holds them

| Class (Eden) | What it looked like | Rule | Gate | Evidence |
|---|---|---|---|---|
| A value only the page holds | A derived value missing on a 2.3 MB page that carried it | 4 | `provenance.rs::a_value_in_any_of_the_pages_json_documents_is_read` | Carousell: call failed → answers |
| The same value, left `null` | `"searchProductFilterMetadata": null`, `isSupported:false` | 5 | `replay.rs::a_value_the_template_holds_as_null_is_not_needed` | Carousell `macbook air`, `nintendo switch` |
| A value the request needs | A page that no longer says what the call sends | 5 | `replay.rs::a_value_the_template_needs_is_not_papered_over` | fails rather than sends a guess |
| A data call never offered | SSE not a candidate (Trip.com) | 3 | `learn.rs::a_search_streaming_its_results_is_a_candidate` | Trip.com route is the SSE |
| A call the page does not make | A widget call that only exists on some page loads | 7 | `replay.rs::an_unsignable_leaf_the_route_does_not_need_is_skipped` | Trip.com step 17/18 skipped |
| A route that cannot be reused | Google Maps `inputs: []`; `adults=2` as a constant | 2 | `learn.rs::every_placeholder_a_route_sends_is_an_input`, `learn.rs::a_one_character_value_the_page_was_asked_is_an_input` | Google Maps answers `phone repair` in 557 ms |
| A site's own script signing | `x-ctx-wclient-req`, `w-payload-source`, `x-ctx-fvpc` | 6 | `sandbox.rs::a_bundles_own_signed_call_is_read_back`, `replay.rs::a_script_signed_step_is_signed_once_the_request_stands` | Trip.com 79/74/49 itineraries |
| A door that refuses the browser | OpenTable 403 (Akamai), eBay 403 | 8 | `engine_is_general.rs::the_engine_does_not_branch_on_a_host` + the bank's `ALLOW_HEADED=1` check | measured: plain headless refused, headed passes |
| A question with nothing to choose | Empty `criteria`/`exchanges` sent to the model | 1 | `judge.rs::an_empty_question_is_never_sent` | no empty request leaves |
| A session value re-minted only by a walk | Lazada's 12.6 s browser for a cookie the page had re-issued | 3 | `client.rs::a_stale_session_is_refreshed_from_the_page_without_a_browser`, `client.rs::a_page_that_hands_back_nothing_new_leaves_the_jar_alone` | a stale chain is re-run from the page, no browser |
| A token the page states | A csrf header or a `<meta>` the route sends | 3 | `client.rs::a_page_that_states_a_routes_token_hands_it_over`, `page.rs::a_pages_meta_tag_is_read_by_its_name` | the page's own answer is the freshest copy |
| A bundle reading its own storage | A signing key or a nonce kept in `localStorage` | 6 | `sandbox.rs::the_pages_own_storage_and_cookies_are_in_front_of_it_when_it_signs` | the page's storages and a writable cookie are in front of it |
| A bundle reading its own page | A `<meta>` token or a config `<script>` the page carried | 4 | `sandbox.rs::the_page_the_walk_saw_is_in_front_of_the_scripts_when_they_sign`, `trace.rs::a_routes_page_is_the_walks_own_document` | the page the walk saw is in front of its scripts |
| A producer fragment, not the app | Trip.com's sandbox made 0 calls: it carried the scripts that *name* a header, not the page's boot code | 1 | `signing.rs::the_pages_own_boot_scripts_ride_in_load_order_and_a_third_partys_do_not`, `signing.rs::a_document_that_names_no_script_carries_only_the_producer`, `signing.rs::the_boot_scripts_stop_at_the_routes_cap` | the page's own document names its scripts, in load order, from a CDN; after it, the app boots and calls |
| A rollover (a content host) read as a third party | A bundle a CDN serves for the page dropped as not-the-site | 1 | same as above (the document, not a host, says what is the page's) | Trip.com: 15 scripts, 3.9 MB, foundation/list-main/ssr-gateway |
| A heal that forgets its page | a rebuilt chain signed nothing: "no page on the route" | 1 | `client.rs::a_heal_keeps_the_page_it_boots_the_scripts_on` | a drifted route still boots its scripts on its page |
| A page's data read as markup | a bundle's start-up asks its config; the sandbox had only the page to boot on | 3 | `sandbox.rs::a_recorded_answer_boots_the_bundle_without_a_line`, `signing.rs::the_pages_own_data_answers_ride_on_the_route` | Trip.com: 28 answers, 245 KB on the route; the config is answered with no line |
| A page's config, written inline | a bundle reads `window._white_config`; the sandbox never ran the page's inline `<script>` | 1 | `sandbox.rs::an_inline_script_the_page_carries_runs_before_the_bundles` | the config is there before the bundle runs |
| A page's state, past the route's cut | `__NEXT_DATA__` sits after 128 KB, so a booted bundle reads nothing | 4 | `trace.rs::a_pages_state_block_past_the_cut_rides_with_its_head` | head whole, JSON blocks kept, markup past the cut left in the walk |
| A page over its own call | a walk holding both picked the page: HTML over the API | 1 | `learn.rs::a_data_call_beats_the_page_that_renders_it` | data call picked; the page answers only when no call does |
| Cookies out of a browser's order | a token bound to the request it came with | 2 | `client.rs::cookies_go_out_in_the_order_a_browser_sends_them` | longest path first, oldest first, expired gone |
| The site's door, misread as drift | eBay/OpenTable 403 treated as a broken route, a browser opened per call | 8 | `graph.rs::a_wall_is_classed_from_what_it_answered`, `replay.rs::a_known_door_is_said_as_a_door` | the refusal names the wall and its credential; only a browser earns a device-bound one |
| A call that lists the records | Trip.com's itinerary stream lost to a call answering a few fare policies | 2 | `learn.rs::the_longest_list_is_how_many_records_an_answer_carried` | the answer that carries the list is the data call |
| A session mistaken for a cursor | Carousell's search `session` dropped as a "next page" token, so every call answered empty | 5 | `paging.rs::a_token_an_earlier_answer_gave_is_not_paging` | a value an earlier answer gave is re-derived, not left out |
| A route that names its contributor | An account id frozen as a constant, read as the caller's on another machine | 2 | `recipe.rs::a_value_that_names_the_contributor_goes_out_as_the_callers`, `recipe.rs::a_route_shares_an_account_key_as_a_parameter` | an account key is the caller's input, not the route's |
| A shared route that needs a browser | A fetched route could not mint its own session | 8 | `client.rs::a_shared_route_mints_only_on_its_own_site_and_only_when_allowed` | only when the owner allows it, only on the route's own site, and the log says so |
| One egress per site | A credential earned from one address, spent from another | 8 | `proxy.rs::a_pinned_site_leaves_through_its_upstream`, `proxy.rs::a_pinned_calls_transport_leaves_through_the_same_upstream` | the browser and the calls leave through one pinned upstream |
| An answer that streams and never ends | Trip.com's SSE held the call open for 55 s | 3 | `http.rs::an_event_streams_answer_is_what_it_said_so_far`, `http.rs::a_blocking_event_streams_answer_is_what_it_said_so_far` | the events it sent are the answer; the call stops at the quiet mark |
| A browser left open by a failed learn | 88 processes at 800 MB | — | close-on-error (`#482`), `mint.rs::a_replay_that_fails_closes_the_browser_it_opened` | browsers close on a failed replay |

Note on the judge: empty judgments already return `None` (`judge.rs` `ask`), which is what the report asked for; the
ledger names the behaviour rather than a second test asserting the same thing.

## Adding a site-shaped thing

If a fix needs a host, a path, a header name or a value that only one site uses, it is in the wrong layer:

- the **walk** carries it (`MintedSession`, the capture, `signing::discover`);
- the **route** carries it (the page template, the scripts, the fields);
- the **jar** carries it;
- a **fixture** under `#[cfg(test)]` carries it, named `*.example`.

The engine reads those. If the shape must be recognised, recognise the *class* (a page with several documents, a value
the template nulls, a stream of events) and let the data say which one it is.
