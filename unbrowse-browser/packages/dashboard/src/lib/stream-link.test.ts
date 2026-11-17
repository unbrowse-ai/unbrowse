import { describe, expect, test } from "bun:test";
import { type SocketLike, startStreamLink, viewportNotice } from "./stream-link";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

class FakeSocket implements SocketLike {
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly port: number) {}
  close() {
    this.readyState = CLOSING;
  }
  /** The browser finished opening. */
  up() {
    this.readyState = OPEN;
    this.onopen?.();
  }
  /** The browser delivers `close`, later than `close()` was called. */
  down() {
    this.readyState = CLOSED;
    this.onclose?.();
  }
}

/** The dashboard around the links: one slot for the socket input goes to, and one clock. */
function dashboard() {
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, { run: () => void; ms: number }>();
  let nextTimer = 1;
  const log: string[] = [];
  const state = { input: null as FakeSocket | null, up: false };
  const start = (port: number) =>
    startStreamLink<FakeSocket>({
      open: () => {
        const socket = new FakeSocket(port);
        sockets.push(socket);
        return socket;
      },
      onSocket: (socket) => {
        state.input = socket;
      },
      onUp: () => {
        state.up = true;
      },
      onDown: () => {
        state.up = false;
      },
      onMessage: (data) => log.push(`${port}:${data}`),
      setTimer: (run, ms) => {
        const id = nextTimer++;
        timers.set(id, { run, ms });
        return id;
      },
      clearTimer: (id) => {
        timers.delete(id as number);
      },
    });
  const tick = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const t of due) t.run();
  };
  return { sockets, timers, log, state, start, tick };
}

describe("the stream to one session", () => {
  test("a lost connection is reported, and input has nowhere to go", () => {
    const d = dashboard();
    d.start(9001);
    d.sockets[0].up();
    expect(d.state.up).toBe(true);
    d.sockets[0].down();
    expect(d.state.up).toBe(false);
    expect(d.state.input).toBeNull();
  });

  test("it comes back by itself, waiting longer each time", () => {
    const d = dashboard();
    d.start(9001);
    d.sockets[0].down();
    expect([...d.timers.values()][0].ms).toBe(2000);
    d.tick();
    d.sockets[1].down();
    expect([...d.timers.values()][0].ms).toBe(4000);
    d.tick();
    d.sockets[2].up();
    expect(d.state.up).toBe(true);
    expect(d.state.input).toBe(d.sockets[2]);
  });
});

describe("moving to another session", () => {
  test("the old socket closing late never takes input from the new session", () => {
    const d = dashboard();
    const stopOld = d.start(9001);
    d.sockets[0].up();
    stopOld();
    d.start(9002);
    d.sockets[0].down();
    d.tick();
    expect(d.sockets.map((s) => s.port)).toEqual([9001, 9002]);
    expect(d.state.input?.port).toBe(9002);
  });

  test("the old socket closing late doesn't mark the new one down", () => {
    const d = dashboard();
    const stopOld = d.start(9001);
    d.sockets[0].up();
    stopOld();
    d.start(9002);
    d.sockets[1].up();
    d.sockets[0].down();
    expect(d.state.up).toBe(true);
  });

  test("a retry waiting for the old session is dropped", () => {
    const d = dashboard();
    const stopOld = d.start(9001);
    d.sockets[0].down();
    stopOld();
    expect(d.timers.size).toBe(0);
  });

  test("the new session starts its waiting afresh", () => {
    const d = dashboard();
    const stopOld = d.start(9001);
    d.sockets[0].down();
    d.tick();
    d.sockets[1].down();
    stopOld();
    d.start(9002);
    d.sockets[2].down();
    expect([...d.timers.values()][0].ms).toBe(2000);
  });
});

describe("what the viewport says when it has no picture", () => {
  const notice = (streamOpen: boolean, browserConnected: boolean, canCast = true) =>
    viewportNotice({ streamOpen, browserConnected, canCast, engine: "lightpanda" });

  test("a lost stream says it is reconnecting, not that the browser is gone", () => {
    expect(notice(false, false)).toBe("Connecting to the session...");
    expect(notice(false, true)).toBe("Connecting to the session...");
  });

  test("an open stream reports the browser", () => {
    expect(notice(true, false)).toBe("No browser connected");
    expect(notice(true, true)).toBe("Waiting for frames...");
    expect(notice(true, true, false)).toBe("Screencast not available for lightpanda");
  });
});
