import { describe, expect, test } from "bun:test";
import { assessIntentResult } from "../src/intent-match.js";

describe("intent result assessment", () => {
  test("passes repository rows locally", () => {
    const verdict = assessIntentResult([
      { full_name: "openai/openai-node", description: "sdk", stargazers_count: 1, url: "https://github.com/openai/openai-node" },
    ], "search repositories");
    expect(verdict.verdict).toBe("pass");
  });

  test("fails deferral payloads", () => {
    const verdict = assessIntentResult({
      message: "Found endpoints",
      available_endpoints: [{ endpoint_id: "abc" }],
    }, "search posts");
    expect(verdict.verdict).toBe("fail");
  });

  test("passes linkedin-style people rows locally", () => {
    const verdict = assessIntentResult([
      { name: "Jane Doe", url: "https://www.linkedin.com/in/jane", public_identifier: "jane", headline: "Engineer" },
      { name: "John Doe", url: "https://www.linkedin.com/in/john", public_identifier: "john", headline: "Founder" },
    ], "search people");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes linkedin normalized feed payloads locally", () => {
    const verdict = assessIntentResult({
      data: {
        data: {
          feedDashMainFeedByMainFeed: {
            "*elements": ["urn:li:fsd_update:(urn:li:activity:1,MAIN_FEED,DEBUG_REASON,DEFAULT,false)"],
          },
        },
      },
      included: [
        {
          entityUrn: "urn:li:fsd_update:(urn:li:activity:1,MAIN_FEED,DEBUG_REASON,DEFAULT,false)",
          commentary: {
            text: {
              text: "hello linkedin",
            },
          },
          actor: {
            "*profileUrn": "urn:li:fsd_profile:abc",
          },
          permalink: "/feed/update/urn:li:activity:1/",
          createdAt: 1772981230951,
        },
        {
          entityUrn: "urn:li:fsd_profile:abc",
          firstName: "Lewis",
          lastName: "Tham",
          publicIdentifier: "lew",
        },
      ],
    }, "get feed posts");

    expect(verdict.verdict).toBe("pass");
  });

  test("fails empty statuses for post intent", () => {
    const verdict = assessIntentResult({ statuses: [], accounts: [{ id: "1", username: "foo" }] }, "search posts");
    expect(verdict.verdict).toBe("fail");
  });

  test("passes nested X trend payloads locally", () => {
    const verdict = assessIntentResult({
      story_topic: {
        stories: {
          items: [
            { trend_results: { result: { rest_id: "1", core: { name: "Topic One", category: "News" }, post_count: "10" } } },
            { trend_results: { result: { rest_id: "2", core: { name: "Topic Two", category: "Other" }, post_count: "20" } } },
          ],
        },
      },
    }, "get trending topics");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes nested X timeline tweet payloads locally", () => {
    const verdict = assessIntentResult({
      data: {
        home: {
          home_timeline_urt: {
            instructions: [
              {
                entries: [
                  {
                    content: {
                      itemContent: {
                        tweet_results: {
                          result: {
                            rest_id: "1",
                            legacy: { full_text: "hello world" },
                            core: { user_results: { result: { legacy: { screen_name: "openai" } } } },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    }, "search tweets");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes nested X user payloads locally", () => {
    const verdict = assessIntentResult({
      data: {
        users: {
          result: [
            {
              rest_id: "1",
              core: { screen_name: "openai", name: "OpenAI" },
              legacy: { description: "AI company", followers_count: 10 },
            },
          ],
        },
      },
    }, "get user profile");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes npm search payloads locally", () => {
    const verdict = assessIntentResult({
      objects: [
        {
          package: {
            name: "openai",
            version: "4.0.0",
            description: "OpenAI API client",
            keywords: ["openai", "ai"],
            links: { npm: "https://www.npmjs.com/package/openai" },
          },
        },
      ],
    }, "search packages");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes PyPI package detail payloads locally", () => {
    const verdict = assessIntentResult({
      info: {
        name: "openai",
        version: "1.0.0",
        summary: "Python client",
        author: "OpenAI",
        requires_dist: ["httpx"],
        package_url: "https://pypi.org/project/openai/",
      },
    }, "get package info");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes stock quote payloads locally", () => {
    const verdict = assessIntentResult({
      quoteResponse: {
        result: [
          {
            symbol: "AAPL",
            shortName: "Apple Inc.",
            regularMarketPrice: 212.34,
            regularMarketChangePercent: 1.23,
            currency: "USD",
          },
        ],
      },
    }, "get stock quote");
    expect(verdict.verdict).toBe("pass");
  });

  test("fails news rows for stock quote intent", () => {
    const verdict = assessIntentResult([
      {
        title: "Apple drops commission rates in China without a fuss",
        url: "https://finance.yahoo.com/news/apple-drops-commission-rates-china-151214768.html",
        image: "https://example.com/thumb.webp",
      },
    ], "get stock quote");
    expect(verdict.verdict).toBe("skip");
  });

  test("passes product rows locally", () => {
    const verdict = assessIntentResult({
      initialData: {
        searchResult: {
          itemStacks: [
            {
              items: [
                {
                  id: "123",
                  name: "Wireless Headphones",
                  price: "$39.99",
                  averageRating: 4.5,
                  numberOfReviews: 120,
                },
              ],
            },
          ],
        },
      },
    }, "search products");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes DOM-style product cards without explicit urls when title description and price are present", () => {
    const verdict = assessIntentResult([
      {
        title: "Sauce Labs Backpack",
        description: "carry.allTheThings() with the sleek, streamlined pack",
        price: "$29.99",
        image: "/static/backpack.jpg",
      },
      {
        title: "Sauce Labs Bike Light",
        description: "A red light isn't the desired state in testing",
        price: "$9.99",
        image: "/static/light.jpg",
      },
      {
        title: "Sauce Labs Bolt T-Shirt",
        description: "Get your testing superhero on",
        price: "$15.99",
        image: "/static/shirt.jpg",
      },
    ], "get products");
    expect(verdict.verdict).toBe("pass");
  });

  test("fails noisy repeated-element chrome for product search intent", () => {
    const verdict = assessIntentResult([
      {
        title: "Results",
        heading_1: "Apple AirPods Pro 3 Wireless Earbuds",
        heading_2: "More results",
        heading_3: "Need help?",
        heading_4: "Related searches",
        heading_5: "Worker well-being",
        heading_6: "Manufacturing practices",
        url: "https://aax-us-east-retail-direct.amazon.com/x/c/abc",
        image: "https://example.com/ad.jpg",
        price: "$25.99",
      },
    ], "search products");
    expect(verdict.verdict).toBe("skip");
  });

  test("fails discord guild affinities for list servers intent", () => {
    const verdict = assessIntentResult({
      guild_affinities: [
        { guild_id: "1", affinity: 453.7 },
        { guild_id: "2", affinity: 32.4 },
      ],
    }, "list my discord servers");
    expect(verdict.verdict).toBe("skip");
  });

  test("passes Docker Hub search payloads locally", () => {
    const verdict = assessIntentResult({
      results: [
        {
          repo_name: "library/nginx",
          short_description: "Official build of Nginx.",
          star_count: 100,
          pull_count: 5000,
        },
      ],
    }, "search images");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes Docker Hub tag payloads locally", () => {
    const verdict = assessIntentResult({
      results: [
        {
          name: "latest",
          full_size: 12345,
          last_updated: "2026-03-07T00:00:00.000000Z",
        },
      ],
    }, "get image tags");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes Hacker News search payloads locally", () => {
    const verdict = assessIntentResult({
      hits: [
        {
          objectID: "123",
          title: "OpenAI launches something",
          url: "https://example.com/openai",
          author: "pg",
          points: 120,
          num_comments: 42,
        },
      ],
    }, "search hacker news");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes Hacker News dom rows locally", () => {
    const verdict = assessIntentResult([
      {
        title: "OpenAI's board has fired Sam Altman",
        link: "https://news.ycombinator.com/item?id=38309611",
        meta: "5710 points|davidbarker|2 years ago|2530 comments",
      },
    ], "search hacker news");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes Hugging Face model search payloads locally", () => {
    const verdict = assessIntentResult([
      {
        id: "openai/gpt-oss-20b",
        pipeline_tag: "text-generation",
        downloads: 12345,
        likes: 678,
        url: "https://huggingface.co/openai/gpt-oss-20b",
      },
    ], "search models");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes Jmail email search payloads locally", () => {
    const verdict = assessIntentResult({
      results: [
        {
          thread: {
            doc_id: "EFTA02393777",
            subject: "(no subject)",
            latest_sender_name: "Richard Kahn",
            formatted_date: "Apr 15, 2016",
            preview: "No problem.",
          },
          matchedEmail: {
            id: "EFTA02393777-3",
            sender: "Clinton T. Hedrington <redacted>",
            content_markdown: "No problem.",
          },
        },
      ],
    }, "search emails");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes GitLab project detail payloads locally", () => {
    const verdict = assessIntentResult({
      name: "gitlab",
      path_with_namespace: "gitlab-org/gitlab",
      description: "GitLab CE mirror",
      web_url: "https://gitlab.com/gitlab-org/gitlab",
      star_count: 1000,
      forks_count: 500,
    }, "get project details");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes documentation search rows locally", () => {
    const verdict = assessIntentResult([
      {
        title: "Fetch API",
        mdn_url: "/en-US/docs/Web/API/Fetch_API",
        summary: "The Fetch API provides an interface for fetching resources.",
      },
    ], "search docs");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes wrapped document rows locally", () => {
    const verdict = assessIntentResult({
      documents: [
        {
          title: "Fetch API",
          mdn_url: "/en-US/docs/Web/API/Fetch_API",
          summary: "Fetch resources over the network.",
          score: 123,
        },
      ],
      metadata: { total: { value: 1 } },
    }, "search docs");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes paper search rows locally", () => {
    const verdict = assessIntentResult([
      {
        title: "OpenAI and reasoning",
        url: "https://arxiv.org/abs/1234.5678",
        summary: "Paper summary",
        author: "Jane Doe",
      },
    ], "search papers");
    expect(verdict.verdict).toBe("pass");
  });

  test("preserves direct package url for non-npm package objects", () => {
    const verdict = assessIntentResult({
      "@type": "SoftwareSourceCode",
      name: "http",
      version: "1.6.0",
      description: "Dart HTTP package",
      url: "https://pub.dev/packages/http",
    }, "get package info");
    expect(verdict.verdict).toBe("pass");
    expect((verdict.projected as Record<string, unknown>).url).toBe("https://pub.dev/packages/http");
  });

  test("passes pub.dev package detail payloads locally", () => {
    const verdict = assessIntentResult({
      name: "http",
      latest: {
        version: "1.6.0",
        pubspec: {
          name: "http",
          version: "1.6.0",
          description: "Composable HTTP client",
          repository: "https://github.com/dart-lang/http/tree/master/pkgs/http",
          topics: ["http", "network"],
        },
      },
    }, "get package info");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes RubyGems package detail payloads locally", () => {
    const verdict = assessIntentResult({
      name: "rails",
      version: "8.1.2",
      authors: "David Heinemeier Hansson",
      info: "Ruby on Rails web framework",
      project_uri: "https://rubygems.org/gems/rails",
    }, "get package info");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes crates package search payloads locally", () => {
    const verdict = assessIntentResult({
      crates: [
        {
          id: "tokio",
          description: "An event-driven, non-blocking I/O platform.",
          max_version: "1.44.1",
          downloads: 123456789,
        },
      ],
    }, "search packages");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes HuggingFace model search payloads when only modelId is present", () => {
    const verdict = assessIntentResult([
      {
        modelId: "openai/gpt-oss-20b",
        downloads: 4242,
        pipeline_tag: "text-generation",
      },
    ], "search models");
    expect(verdict.verdict).toBe("pass");
  });

  test("fails question-like nav rows without question detail", () => {
    const verdict = assessIntentResult([
      { title: "Newest", link: "/questions/tagged/javascript?tab=Newest" },
      { title: "Unanswered", link: "/questions/tagged/javascript?tab=Unanswered" },
    ], "get tag questions");
    expect(verdict.verdict).toBe("skip");
  });

  test("passes rich question rows locally", () => {
    const verdict = assessIntentResult([
      {
        title: "Why does fetch fail here?",
        url: "https://example.com/questions/1",
        votes: 10,
        answer_count: 2,
        author: "alice",
      },
      {
        title: "How do I parse JSON safely?",
        url: "https://example.com/questions/2",
        score: 7,
        num_answers: 1,
        date: "2026-03-09",
      },
    ], "get tag questions");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes Stack Exchange question payloads locally", () => {
    const verdict = assessIntentResult({
      items: [
        {
          title: "Why does fetch fail here?",
          link: "https://stackoverflow.com/questions/1/why-does-fetch-fail-here",
          score: 10,
          answer_count: 2,
          owner: { display_name: "alice" },
          last_activity_date: 1773000000,
        },
        {
          title: "How do I parse JSON safely?",
          link: "https://stackoverflow.com/questions/2/how-do-i-parse-json-safely",
          score: 7,
          answer_count: 1,
          owner: { display_name: "beto" },
          last_activity_date: 1773001000,
        },
      ],
    }, "get tag questions");
    expect(verdict.verdict).toBe("pass");
  });

  test("fails weak post rows that are only url plus text blob", () => {
    const verdict = assessIntentResult([
      {
        url: "https://lobste.rs/s/abc123/example",
        text: "69 Example post authored by someone 2 hours ago | 43 comments",
      },
    ], "get posts");
    expect(verdict.verdict).toBe("skip");
  });

  test("passes DEV tag article payloads locally", () => {
    const verdict = assessIntentResult([
      {
        id: 3305714,
        title: "Unlocking AI Resilience",
        description: "Mastering state persistence with LangGraph and PostgreSQL",
        url: "https://dev.to/programmingcentral/unlocking-ai-resilience-mastering-state-persistence-with-langgraph-and-postgresql-50h0",
        published_at: "2026-03-09T00:00:00Z",
        positive_reactions_count: 5,
        comments_count: 2,
        user: { name: "Programming Central" },
      },
    ], "get tag posts");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes DEV tag article payloads without embedded user objects", () => {
    const verdict = assessIntentResult([
      {
        title: "WebGPU benchmark",
        path: "/sylwia-lask/webgpu-demo",
        url: "https://dev.to/sylwia-lask/webgpu-demo",
      },
    ], "get tag posts");
    expect(verdict.verdict).toBe("pass");
  });

  test("passes Lobsters-style post rows when score is embedded in text", () => {
    const verdict = assessIntentResult([
      {
        title: "Interesting systems post",
        url: "/s/abc123/interesting_systems_post",
        text: "162 Interesting systems post systems.example.com authored by alice 2 hours ago | 12 comments",
      },
    ], "get posts");
    expect(verdict.verdict).toBe("pass");
  });

  test("fails dictionary related-term rows without definitions", () => {
    const verdict = assessIntentResult([
      { title: "operative", link: "/dictionary/english/operative" },
      { title: "spy", link: "/dictionary/english/spy" },
    ], "get definition");
    expect(verdict.verdict).toBe("skip");
  });
});
