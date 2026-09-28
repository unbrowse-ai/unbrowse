import { Action, ActionPanel, Detail, getPreferenceValues, LaunchProps } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useRef } from "react";
import { runMarkdown, runTask } from "./lib/unbrowse";

export default function Command(props: LaunchProps<{ arguments: Arguments.RunSiteTask }>) {
  const { apiKey } = getPreferenceValues<Preferences>();
  const { task, site } = props.arguments;
  const abortable = useRef<AbortController>(null);
  const { data, isLoading, error } = usePromise(
    async (taskText: string, siteText?: string) =>
      runTask(apiKey, taskText, siteText, { signal: abortable.current?.signal }),
    [task, site],
    { abortable, failureToastOptions: { title: "Task failed" } },
  );

  const markdown = data ? runMarkdown(task, data) : error ? `**The task failed.** ${error.message}` : `## ${task}`;
  const resultJson = data?.status === "succeeded" ? JSON.stringify(data.result ?? null, null, 2) : undefined;

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      metadata={
        data ? (
          <Detail.Metadata>
            <Detail.Metadata.Label title="Status" text={data.status} />
            {data.capabilityId ? <Detail.Metadata.Label title="Tool" text={data.capabilityId} /> : null}
            <Detail.Metadata.Label title="Run" text={data.runId} />
          </Detail.Metadata>
        ) : undefined
      }
      actions={
        data ? (
          <ActionPanel>
            {resultJson ? <Action.CopyToClipboard title="Copy Result" content={resultJson} /> : null}
            <Action.CopyToClipboard title="Copy Run ID" content={data.runId} />
            <Action.OpenInBrowser title="Open Unbrowse" url="https://unbrowse.ai/app" />
          </ActionPanel>
        ) : undefined
      }
    />
  );
}
