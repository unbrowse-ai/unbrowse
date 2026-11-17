/**
 * The dashboard's stream to one session, kept apart from React so a test can
 * play out the order sockets really close in. `close()` only asks: the browser
 * delivers `close` later, often after the next session's socket exists. So each
 * link answers only to its own current socket, and a link that was stopped does
 * nothing at all. Without that, a late `close` marked the new session down and
 * its retry could reopen the old port and take input from the new session.
 */

/** The part of a WebSocket the link uses. `any` so the DOM's handler types fit it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = ((event: any) => unknown) | null;

export interface SocketLike {
  readyState: number;
  onopen: Handler;
  onclose: Handler;
  onerror: Handler;
  onmessage: Handler;
  close(): void;
}

export interface StreamLink<S extends SocketLike> {
  open: () => S;
  /** The socket input should go to, or null while there is none. */
  onSocket: (socket: S | null) => void;
  onUp: () => void;
  onDown: () => void;
  onMessage: (data: string) => void;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

const FIRST_RETRY_MS = 2000;
const LONGEST_RETRY_MS = 30000;

/** Opens the stream and keeps it open until the returned function stops it. */
export function startStreamLink<S extends SocketLike>(link: StreamLink<S>): () => void {
  let stopped = false;
  let current: S | null = null;
  let timer: unknown = null;
  let retries = 0;

  const connect = () => {
    timer = null;
    if (stopped) return;
    const socket = link.open();
    current = socket;
    link.onSocket(socket);

    socket.onopen = () => {
      if (socket !== current) return;
      retries = 0;
      link.onUp();
    };
    socket.onclose = () => {
      if (socket !== current) return;
      current = null;
      link.onSocket(null);
      link.onDown();
      const delay = Math.min(FIRST_RETRY_MS * 2 ** retries, LONGEST_RETRY_MS);
      retries++;
      timer = link.setTimer(connect, delay);
    };
    socket.onerror = () => socket.close();
    socket.onmessage = (event: { data: string }) => {
      if (socket === current) link.onMessage(event.data);
    };
  };

  connect();

  return () => {
    stopped = true;
    if (timer !== null) link.clearTimer(timer);
    const socket = current;
    current = null;
    link.onSocket(null);
    socket?.close();
  };
}

/** What the viewport says when it has no picture to show. */
export function viewportNotice(view: {
  streamOpen: boolean;
  browserConnected: boolean;
  canCast: boolean;
  engine: string;
}): string {
  if (!view.streamOpen) return "Connecting to the session...";
  if (!view.browserConnected) return "No browser connected";
  return view.canCast ? "Waiting for frames..." : `Screencast not available for ${view.engine}`;
}
