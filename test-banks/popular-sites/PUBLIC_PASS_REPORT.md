# 400-site public HTTP pass

The [per-site results](public-all-results.json) cover every domain in the
400-site inventory derived from the [Tranco GQ3LK list](https://tranco-list.eu/list/GQ3LK/full).
The pass ran on **2026-10-28, 06:46:47–06:48:26 UTC**. It used an
unauthenticated HTTP client, **not Chrome**. Each site received one initial
HTTPS homepage GET and, when HTML exposed a safe same-host link, one initial
GET for that observed route. Redirects were limited to five per request,
responses to 256 KiB, per-request timeout to seven seconds, and concurrency
to 12 sites. Each site has a status, final origin, redirect chain, latency,
classification, and route outcome or skip reason.

| Homepage outcome | Sites |
| --- | ---: |
| HTTP 200 with HTML MIME (`public_html`) | 319 |
| Challenge or denial status (403, 429, 503) | 48 |
| Network error | 18 |
| HTTP error other than the challenge statuses | 6 |
| Redirect stopped (limit or non-HTTPS target) | 5 |
| Other 2xx response | 4 |
| **Total with outcome** | **400** |

**`public_html` means only HTTP 200 plus an HTML MIME type.** It does not prove
that the body is real site content, that an interstitial was absent, or that
Unbrowse has learned a reusable route. This is a public reachability and
discovery pass, not a 400-site browser or route-replay pass. Challenge detection
uses response status and a few strong page markers; a 200 challenge may remain
in the `public_html` group.

| Observed-link outcome | Sites |
| --- | ---: |
| Safe same-host link observed and GET attempted | 218 |
| Route returned HTTP 200 with HTML MIME | 204 |
| Route redirected off host and was stopped | 8 |
| Route challenge or denial | 4 |
| Other route HTTP error | 2 |
| No route attempted | 182 |

The 182 route skips break down as: 81 with no safe same-host link in the bounded
homepage HTML, 48 homepage challenge/denials, 20 homepage redirects outside
the inventoried domain, 18 homepage network errors, 6 other homepage HTTP
errors, 5 blocked homepage redirects, and 4 nonstandard 2xx homepages. The
per-site JSON gives each reason. **321** homepages had at least one redirect.
Median homepage latency was **1,260.5 ms** (95th percentile **5,030 ms**);
median observed-route latency was **722.5 ms** (95th percentile **2,197 ms**).
Latency includes the bounded response read and observed redirects.

The three reserved targets inside the inventory received only this public GET
pass: X had a 200 HTML homepage and a 200 HTML observed route; Instagram had a
200 HTML homepage with no safe same-host link in the bounded HTML; LinkedIn had
a 200 HTML homepage and a 200 HTML observed route. Their auth and deeper
site-specific flows remain deferred. Carousell is outside the selected 400 and
was not visited.

## Separate local Chrome checks

The existing browser harness ran **12** public checks on four sites, each with
an isolated temporary local Chrome profile. Ten configured Wikipedia and
GOV.UK route checks passed. For two ambiguous HTTP homepages, local Chrome
also observed **202** at Booking.com and **403** at NYTimes.com; those two
checks did not pass content assertions. These are [separate Chrome results](browser-smoke-booking.json),
not browser validation of the 400-site batch. No login, form submission,
purchase, message, or account change was attempted.

The HTTP runner now rejects future redirects to private/local IP addresses or
special-use hosts. The completed results were recorded before that guard was
added; inspection of their saved redirect URLs found no literal private IP or
special-use destination. The saved results were retained without rerunning
the batch.

Run `python3 test-banks/popular-sites/validate.py` and
`python3 -m unittest discover -s test-banks/popular-sites -p 'test_*.py'` from
the `unbrowse-core` root to validate the fixtures, all 400 outcomes, and
safety logic.
