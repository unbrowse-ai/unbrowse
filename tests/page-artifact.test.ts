import { describe, expect, it } from "bun:test";
import { buildPageArtifactCapture } from "../src/execution/index.js";

describe("page artifact capture", () => {
  it("creates a replayable page endpoint from structured html", () => {
    const html = `
      <html><body>
        <script type="application/json" data-target="react-app.embeddedData">
          {"payload":{"results":[
            {"followers":10000,"language":"TypeScript","hl_trunc_description":"Official SDK","repo":{"repository":{"owner_login":"openai","name":"openai-node"}}},
            {"followers":25000,"language":"Python","hl_trunc_description":"Python SDK","repo":{"repository":{"owner_login":"openai","name":"openai-python"}}}
          ]}}
        </script>
      </body></html>
    `;

    const artifact = buildPageArtifactCapture("https://github.com/search?q=openai&type=repositories", "search repositories", html);
    expect(artifact.endpoint?.dom_extraction?.extraction_method).toBe("repeated-elements");
    expect(Array.isArray(artifact.result?.data)).toBe(true);
  });

  it("extracts linkedin embedded feed payloads from authenticated html", () => {
    const html = `
      <html><body>
        <code style="display:none" id="bpr-guid-1">
          {&quot;data&quot;:{&quot;data&quot;:{&quot;feedDashMainFeedByMainFeed&quot;:{&quot;*elements&quot;:[&quot;urn:li:fsd_update:(urn:li:activity:1,MAIN_FEED,DEBUG_REASON,DEFAULT,false)&quot;]}}},&quot;included&quot;:[{&quot;entityUrn&quot;:&quot;urn:li:fsd_update:(urn:li:activity:1,MAIN_FEED,DEBUG_REASON,DEFAULT,false)&quot;,&quot;commentary&quot;:{&quot;text&quot;:{&quot;text&quot;:&quot;hello linkedin&quot;}},&quot;actor&quot;:{&quot;*profileUrn&quot;:&quot;urn:li:fsd_profile:abc&quot;},&quot;permalink&quot;:&quot;/feed/update/urn:li:activity:1/&quot;},{&quot;entityUrn&quot;:&quot;urn:li:fsd_profile:abc&quot;,&quot;firstName&quot;:&quot;Lewis&quot;,&quot;lastName&quot;:&quot;Tham&quot;,&quot;publicIdentifier&quot;:&quot;lew&quot;}]}
        </code>
        <code style="display:none" id="datalet-bpr-guid-1">
          {"request":"/voyager/api/graphql?includeWebMetadata=true&variables=(start:0,count:3,sortOrder:MEMBER_SETTING)&queryId=voyagerFeedDashMainFeed.923020905727c01516495a0ac90bb475","status":200,"body":"bpr-guid-1","method":"GET","headers":{"x-li-uuid":"abc"}}
        </code>
      </body></html>
    `;

    const artifact = buildPageArtifactCapture("https://www.linkedin.com/feed/", "get linkedin feed posts", html, true);
    expect(artifact.endpoint?.url_template).toContain("voyagerFeedDashMainFeed");
    expect(artifact.endpoint?.semantic?.auth_required).toBe(true);
    expect(artifact.result && typeof artifact.result.data === "object").toBe(true);
  });
});
