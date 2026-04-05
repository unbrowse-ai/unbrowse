export function makeAttribution(requestId: string, source: string): string {
  const payload = JSON.stringify({
    utm_source: source,
    channel: "llm",
    content_id: requestId,
  });
  return Buffer.from(payload).toString("base64");
}

export function injectAttribution(command: string, b64: string): string {
  const prefix = `UNBROWSE_ATTRIBUTION_B64='${b64}'`;
  if (command.includes("| bash")) {
    return command.replace("| bash", `| env ${prefix} bash`);
  }
  if (command.includes("./setup")) {
    return command.replace("./setup", `${prefix} ./setup`);
  }
  if (command.includes("unbrowse setup")) {
    return command.replace("unbrowse setup", `${prefix} unbrowse setup`);
  }
  return `${prefix} ${command}`;
}
