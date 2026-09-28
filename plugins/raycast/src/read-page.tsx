import { Action, ActionPanel, Detail, getPreferenceValues, LaunchProps } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useRef } from "react";
import { normalizeUrl, pageMarkdown, scrapePage } from "./lib/unbrowse";

export default function Command(props: LaunchProps<{ arguments: Arguments.ReadPage }>) {
  const { apiKey } = getPreferenceValues<Preferences>();
  const abortable = useRef<AbortController>(null);
  const { data, isLoading, error } = usePromise(
    async (input: string) => scrapePage(apiKey, normalizeUrl(input), { signal: abortable.current?.signal }),
    [props.arguments.url],
    { abortable, failureToastOptions: { title: "Couldn't read page" } },
  );

  const markdown = data ? pageMarkdown(data) : error ? `**Couldn't read the page.** ${error.message}` : "";
  const pageUrl = data?.finalUrl ?? data?.url;

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      navigationTitle={data?.metadata?.title}
      metadata={
        data && pageUrl ? (
          <Detail.Metadata>
            <Detail.Metadata.Link title="Page" target={pageUrl} text={new URL(pageUrl).hostname} />
            {data.via ? (
              <Detail.Metadata.Label title="Fetched" text={data.via === "rendered" ? "Browser" : "HTTP"} />
            ) : null}
          </Detail.Metadata>
        ) : undefined
      }
      actions={
        data ? (
          <ActionPanel>
            <Action.CopyToClipboard title="Copy Markdown" content={data.markdown ?? ""} />
            <Action.Paste title="Paste Markdown" content={data.markdown ?? ""} />
            {pageUrl ? <Action.OpenInBrowser url={pageUrl} /> : null}
          </ActionPanel>
        ) : undefined
      }
    />
  );
}
