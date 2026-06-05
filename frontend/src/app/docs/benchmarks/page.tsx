import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Benchmarks — Unbrowse Docs",
  description:
    "How Unbrowse measures itself. Corpus shape, evidence fields, classification rubric, and why the executor never renders its own verdict.",
  alternates: { canonical: "https://www.unbrowse.ai/docs/benchmarks" },
};

export default function DocsBenchmarksPage() {
  return (
    <>
      <h1>Benchmarks</h1>
      <p>
        This page explains how Unbrowse benchmarks are derived, how to read the
        evidence rows they produce, and why the executor never writes its own
        pass/fail verdict. For the methodology in the codebase, see{" "}
        <a href="https://github.com/unbrowse-ai/unbrowse">
          <code>docs/benchmarks.md</code>
        </a>{" "}
        in the open client. For the published paper benchmark (3.6× speedup vs Playwright across
        94 live domains), see{" "}
        <Link href="/benchmark-deep-dive">the benchmark deep-dive</Link>.
      </p>

      <h2>Headline results (reproducible, gated)</h2>
      <ul>
        <li>
          <strong>Anti-bot retrieval — 9/9 vs naive 0/9.</strong> On a
          reproducible nine-post corpus across three communities of a major
          JavaScript-challenge-gated social platform, ground-truthed against the
          platform&apos;s own data, Unbrowse retrieves the real content on{" "}
          <strong>9/9</strong> posts where a naive HTTP client is blocked on{" "}
          <strong>100%</strong> of requests (HTTP 403).
        </li>
        <li>
          <strong>Latency &amp; cost — 3.6× / 5.4× / 40×.</strong> Across 94
          live domains: <strong>3.6× mean / 5.4× median</strong> speedup and{" "}
          <strong>40× fewer tokens</strong>; on the API-native path ~30× faster
          and ~90× cheaper than driving a browser.
        </li>
        <li>
          <strong>Execute, don&apos;t guess — at model scale.</strong> The same
          on-device agent, tools vs no tools, turns tasks it fails from weights
          alone into tasks it solves: code-correctness{" "}
          <strong>25% → 100%</strong>, knowledge-not-in-weights{" "}
          <strong>0% → 95%</strong>, hard reasoning families{" "}
          <strong>50% → 92%</strong>, and applying a retrieved skill vs
          reasoning from scratch <strong>63% → 93%</strong>. The architecture is
          the capability, not the raw weights.
        </li>
      </ul>

      <h2>The shape of a run</h2>
      <p>A run is three layers:</p>
      <ul>
        <li>
          <strong>Corpus</strong> — a list of <code>intent | url</code> probes.
          Each row is a real agent task. Lives at{" "}
          <code>harness/probes/corpus.txt</code> (default) or{" "}
          <code>scripts/corpus/benchmark-baseline.txt</code> (full 323-probe
          set).
        </li>
        <li>
          <strong>Executor</strong> — <code>scripts/bench-run.ts</code> drives{" "}
          <code>unbrowse resolve</code> against each probe and dumps raw
          per-probe artifacts. <em>Emits no heuristic verdict.</em>
        </li>
        <li>
          <strong>Judgment</strong> — the calling LLM agent reads the evidence
          rows + raw artifacts in-thread and renders a verdict per the rubric
          below.
        </li>
      </ul>

      <h2>Why the executor doesn&apos;t emit verdicts</h2>
      <p>
        A 200 response can be a captcha page. An empty array can be a real &quot;no
        results.&quot; A structured shortlist can be the wrong template firing. None
        of those distinctions survive a regex. The truth-claim &mdash; &quot;is the
        agent&apos;s intent satisfied?&quot; &mdash; stays with the party that has the
        context, which is the calling LLM.
      </p>
      <p>
        Earlier benches tried to short-circuit judgment with classifier scripts.
        Two failure modes recurred until the principle became binding:
      </p>
      <ol>
        <li>
          <strong>HTTP-shape lies.</strong>{" "}
          <code>status_code === 200 → PASS</code> looked clean and was wrong all
          the time. Cloudflare-Turnstile interstitials return 200. Captcha
          pages return 200. Empty SSR pages return 200. The product reported
          success and the agent got nothing useful.
        </li>
        <li>
          <strong>Per-site heuristic creep.</strong>{" "}
          <code>if (domain === &quot;some-site.com&quot;) op SearchTimeline +220</code> shaped
          early rankers. It generalised to nothing, the 11th site shipped
          wrong, no one noticed, and the bench reported green because the
          heuristic that scored the call was the same heuristic that scored
          the verdict.
        </li>
      </ol>
      <p>
        The executor that exists now is deliberately incapable of writing a
        verdict column. It only collects evidence.
      </p>

      <h2>Evidence the executor records</h2>
      <p>
        For every probe, <code>results.jsonl</code> carries one row with these
        fields. None of them are verdicts:
      </p>
      <ul>
        <li>
          <code>goal</code>, <code>url</code>, <code>auth</code>,{" "}
          <code>lane</code> &mdash; the probe
        </li>
        <li>
          <code>source</code> &mdash; <code>marketplace</code>,{" "}
          <code>cache</code>, <code>live-capture</code>,{" "}
          <code>dom-fallback</code>, <code>direct-fetch</code>, or empty
        </li>
        <li>
          <code>trace_success</code>, <code>trace_skill_id</code> &mdash; top-level
          trace from the CLI
        </li>
        <li>
          <code>has_available_operations</code>, <code>n_operations</code>{" "}
          &mdash; shortlist size the agent would see (two-tool-call contract)
        </li>
        <li>
          <code>error_code</code>, <code>error_message</code> &mdash; what the
          CLI said when it failed
        </li>
        <li>
          <code>captured_html_bytes</code>, <code>captured_text_bytes</code>,{" "}
          <code>captured_title</code> &mdash; did the browser actually render
          something, or are we looking at a captcha shell?
        </li>
        <li>
          <code>captured_api_calls</code> &mdash; how many XHR/fetch calls fired
        </li>
        <li>
          <code>filter_rejections</code> &mdash;{" "}
          <code>{"{reason: count}"}</code> map showing where the ranker dropped
          candidates
        </li>
        <li>
          <code>browser_block_signals</code> &mdash; vendor signals
          (<code>vendor:cloudflare</code>, <code>challenge_title</code>,{" "}
          <code>no_html_many_apis</code>, <code>sparse_capture_mostly_noise</code>)
        </li>
        <li>
          <code>capture_diagnostic</code> &mdash;{" "}
          <code>no_endpoints_extracted</code> /{" "}
          <code>all_endpoints_filtered_by_noise_rules</code> /{" "}
          <code>endpoints_scored_below_relevance_threshold</code>
        </li>
        <li>
          <code>auth_recommended</code> &mdash; true if the resolve thinks the
          user needs to authenticate
        </li>
        <li>
          <code>cli_exit</code>, <code>cli_timeout</code> &mdash; process exit
          details, distinguishes &quot;browser hung&quot; from &quot;extraction empty&quot;
        </li>
        <li>
          <code>response_text_excerpt</code> &mdash; first 400 chars of the
          response so the agent can confirm on-topic content
        </li>
      </ul>

      <h2>Classification rubric (applied in-thread)</h2>
      <p>First match wins:</p>
      <table>
        <thead>
          <tr>
            <th>Bucket</th>
            <th>Trigger</th>
            <th>Counted?</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>ANTIBOT_BLOCK</code>
            </td>
            <td>
              <code>browser_block_signals</code> contains{" "}
              <code>vendor:*</code>, <code>challenge_title</code>, or{" "}
              <code>no_html_many_apis</code>; OR <code>capture_diagnostic</code>{" "}
              in <code>{"{no_endpoints_extracted, all_endpoints_filtered_by_noise_rules}"}</code>
            </td>
            <td>
              ✗ Fail (product capability gap &mdash; reliable access here is
              exactly the wedge we should differentiate on)
            </td>
          </tr>
          <tr>
            <td>
              <code>AUTH_GATED</code>
            </td>
            <td>
              <code>error_code === &quot;auth_required&quot;</code> or{" "}
              <code>auth_recommended === true</code>
            </td>
            <td>Excluded from coverage (user credential gap, not product)</td>
          </tr>
          <tr>
            <td>
              <code>SKIPPED_NO_FRESH_COOKIES</code>
            </td>
            <td>
              Probe needs auth AND the existing browser session has no fresh
              cookie for the domain
            </td>
            <td>Excluded from coverage (skipping is honest; 401ing is noise)</td>
          </tr>
          <tr>
            <td>
              <code>PASS</code>
            </td>
            <td>
              <code>has_available_operations === true && n_operations &gt; 0</code>,
              OR <code>trace_success === true</code> + <code>source</code> ∈{" "}
              <code>{"{dom-fallback, direct-fetch, browse-session, live-capture}"}</code>
            </td>
            <td>✓ Pass</td>
          </tr>
          <tr>
            <td>
              <code>SPARSE_REVIEW</code>
            </td>
            <td>
              <code>browser_block_signals</code> contains only{" "}
              <code>sparse_capture_mostly_noise</code> (no vendor)
            </td>
            <td>Agent reads the .out file and judges in-thread</td>
          </tr>
          <tr>
            <td>
              <code>PRODUCT_FAIL</code>
            </td>
            <td>Everything else</td>
            <td>✗ Fail</td>
          </tr>
        </tbody>
      </table>

      <h2>The coverage metric</h2>
      <pre>
        <code>
          coverage = PASS / (PASS + PRODUCT_FAIL + SPARSE_REVIEW + ANTIBOT_BLOCK)
        </code>
      </pre>
      <p>
        <code>AUTH_GATED</code> and <code>SKIPPED_NO_FRESH_COOKIES</code> are
        excluded because the agent cannot proceed without user-supplied
        credentials &mdash; that&apos;s a setup gap, not a runtime product gap.
      </p>
      <p>
        <code>ANTIBOT_BLOCK</code> counts toward the denominator deliberately.
        &quot;We have 100% coverage except for the blocked sites&quot; is dishonest when
        the blocked sites are exactly where Unbrowse needs to differentiate
        (reliable access via its existing browser session and fallback paths).
        Counting them as a failure mode
        makes the bench tell the truth.
      </p>

      <h2>Running a benchmark</h2>
      <pre>
        <code>{`# Default corpus, 3 workers, 45s per probe
bun scripts/bench-run.ts

# Pick a specific corpus + larger budget for cold-cache sites
bun scripts/bench-run.ts --corpus harness/probes/corpus.txt --timeout 90 --parallel 4

# Re-extract evidence from an existing run (after extractor fixes)
# without paying the CLI wall-clock again
bun scripts/bench-reextract.ts .bench-local/run-<timestamp>`}</code>
      </pre>
      <p>Output lands at:</p>
      <ul>
        <li>
          <code>.bench-local/run-&lt;ts&gt;/results.jsonl</code> &mdash; one
          evidence row per probe
        </li>
        <li>
          <code>.bench-local/run-&lt;ts&gt;/&lt;idx&gt;_&lt;slug&gt;.out</code>{" "}
          &mdash; full raw CLI stdout+stderr
        </li>
        <li>
          <code>.bench-local/run-&lt;ts&gt;/index.txt</code> &mdash; probe id
          → URL → exit code
        </li>
        <li>
          <code>.bench-local/run-&lt;ts&gt;/manifest.json</code> &mdash; run
          metadata (corpus, parallel, timing)
        </li>
      </ul>

      <h2>Latest agent verdict</h2>
      <p>
        The most recent run sits at <strong>50% coverage</strong> on a 19-probe
        cross-section of the corpus (developer registries, news aggregators,
        code hosts, social platforms, search, travel, public datasets):
      </p>
      <ul>
        <li>
          <strong>PASS = 9</strong> &mdash; developer registries, news
          aggregators, code-search, a social home timeline, a travel search,
          and a public dataset (one via search fallback)
        </li>
        <li>
          <strong>ANTIBOT_BLOCK = 4</strong> &mdash; reCAPTCHA-gated community
          threads, an auth-walled social search, and a Turnstile-gated probe
          page
        </li>
        <li>
          <strong>PRODUCT_FAIL = 5</strong> &mdash; a profile timeline, a DeFi
          app, a campus dataset, a biomedical index, and a reviews site (all
          hang at &quot;Still working. Searching cached routes…&quot;)
        </li>
        <li>
          <strong>AUTH_GATED = 1</strong> (excluded) &mdash; a logged-in
          professional-network feed
        </li>
      </ul>
      <p>
        The 5 <code>PRODUCT_FAIL</code> rows share a signature &mdash; the
        in-process app hangs at &quot;Still working&quot; and never emits the top-level
        JSON before the 45s budget elapses. That&apos;s the highest-priority
        regression and the next thing worth a focused fix.
      </p>

      <h2>Why this matters</h2>
      <p>
        Every probe in the corpus is a contract: it asserts what an agent
        should be able to do. The coverage number is the percentage of those
        contracts the product currently honours. The number can go down. When
        it does, the per-probe row tells the agent (and the reader) exactly
        why &mdash; not a sanitised pass/fail flag, but the raw filter
        rejections, the browser block signals, the captured byte counts, the
        ranker scoring evidence. Reading those rows is how the product gets
        better.
      </p>
    </>
  );
}
