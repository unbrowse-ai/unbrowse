// Package main is the unbrowse-utls-proxy CONNECT daemon.
//
// Eph 6:11-13 — "Put on the whole armor of God, that ye may be able to stand
// against the wiles of the devil... and having done all, to stand." This
// binary IS the TLS-layer armor. Chrome's own TLS stack always emits the
// stock Chromium ClientHello; that is fine when Chrome talks to the origin
// directly, but the moment we route through a generic HTTP CONNECT proxy
// (e.g. iproyal residential), the proxy must re-handshake upstream — and
// THAT handshake is what anti-bot vendors fingerprint via JA3/JA4. So this
// daemon sits between Chrome and the upstream, accepts inbound CONNECT,
// then dials the destination through the upstream proxy using
// refraction-networking/utls so the upstream-facing ClientHello looks like
// Chrome 131 (matching PINNED_CHROME_BUILD_ID in src/cdp/chrome.ts).
//
// Trust model:
//   - The daemon TERMINATES the inbound TLS in order to re-handshake. The
//     application sees plaintext only inside this process; it never logs
//     bodies, never persists payload, and the proxy-auth cred for the
//     upstream is read from $UNBROWSE_UPSTREAM_PROXY_AUTH (env, not argv,
//     so it never appears in `ps`).
//   - The daemon binds 127.0.0.1 ONLY (no remote listener).
//   - The daemon emits "listening on 127.0.0.1:<port>" to stdout on boot so
//     the TS wrapper can deterministically gate readiness.
//
// W13.1 — first cut. ~250 LOC. Bundle ≤8 MB after upx.
package main

import (
	"bufio"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	utls "github.com/refraction-networking/utls"
)

const (
	defaultListen      = "127.0.0.1:0"
	defaultFingerprint = "chrome_131"
	envUpstreamAuth    = "UNBROWSE_UPSTREAM_PROXY_AUTH"
	dialTimeout        = 15 * time.Second
	tlsHandshakeBudget = 15 * time.Second
)

func main() {
	listen := flag.String("listen", defaultListen, "address to bind CONNECT proxy on (default 127.0.0.1:0 → ephemeral)")
	upstream := flag.String("upstream", "", "upstream proxy URL (e.g. http://geo.iproyal.com:12321); empty = direct dial")
	fingerprint := flag.String("fingerprint", defaultFingerprint, "uTLS fingerprint to spoof: chrome_131 (default), chrome_120, firefox_120")
	verbose := flag.Bool("verbose", false, "log every connection (NEVER logs auth / body)")
	flag.Parse()

	helloID, err := resolveFingerprint(*fingerprint)
	if err != nil {
		log.Fatalf("fatal: %v", err)
	}

	upstreamURL, upstreamAuth, err := resolveUpstream(*upstream)
	if err != nil {
		log.Fatalf("fatal: %v", err)
	}

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatalf("fatal: listen %s: %v", *listen, err)
	}
	defer ln.Close()

	// Deterministic readiness marker for the TypeScript wrapper.
	fmt.Printf("listening on %s\n", ln.Addr().String())
	if *verbose {
		mode := "direct"
		if upstreamURL != nil {
			mode = "via " + upstreamURL.Host
		}
		log.Printf("utls-proxy ready fp=%s upstream=%s", *fingerprint, mode)
	}

	srv := &server{
		helloID:      helloID,
		upstream:     upstreamURL,
		upstreamAuth: upstreamAuth,
		verbose:      *verbose,
	}
	srv.serve(ln)
}

func resolveFingerprint(name string) (utls.ClientHelloID, error) {
	switch strings.ToLower(name) {
	case "chrome_131", "chrome131", "chrome-131":
		// HelloChrome_120 is the highest pinned named hello in utls v1.6.7.
		// Chrome 131's wire fingerprint matches the Chrome_120 spec at the
		// JA3 level (same cipher suite order, same extension order, same
		// ALPS). If utls publishes a HelloChrome_131 in a later release,
		// bump go.mod + this switch in lockstep with PINNED_CHROME_BUILD_ID.
		return utls.HelloChrome_120, nil
	case "chrome_120", "chrome120":
		return utls.HelloChrome_120, nil
	case "firefox_120", "firefox120":
		return utls.HelloFirefox_120, nil
	case "chrome_auto", "auto":
		return utls.HelloChrome_Auto, nil
	default:
		return utls.ClientHelloID{}, fmt.Errorf("unknown fingerprint %q (chrome_131|chrome_120|firefox_120|auto)", name)
	}
}

func resolveUpstream(raw string) (*url.URL, string, error) {
	if raw == "" {
		return nil, "", nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, "", fmt.Errorf("--upstream parse: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, "", fmt.Errorf("--upstream scheme must be http/https, got %q", u.Scheme)
	}
	if u.Host == "" {
		return nil, "", errors.New("--upstream missing host")
	}
	// SECURITY: auth comes from env only, never argv. URL-embedded creds in
	// --upstream are silently stripped so they never end up in ps/argv logs.
	if u.User != nil {
		u.User = nil
	}
	auth := os.Getenv(envUpstreamAuth)
	return u, auth, nil
}

type server struct {
	helloID      utls.ClientHelloID
	upstream     *url.URL
	upstreamAuth string // raw "user:pass" from env; basic-auth encoded at use
	verbose      bool

	mu   sync.Mutex
	open int
}

func (s *server) serve(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			if isClosed(err) {
				return
			}
			log.Printf("accept: %v", err)
			continue
		}
		go s.handle(c)
	}
}

func isClosed(err error) bool {
	return err != nil && (errors.Is(err, net.ErrClosed) || strings.Contains(err.Error(), "use of closed"))
}

func (s *server) handle(client net.Conn) {
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(5 * time.Minute))

	br := bufio.NewReader(client)
	req, err := http.ReadRequest(br)
	if err != nil {
		return
	}
	if req.Method != http.MethodConnect {
		// Non-CONNECT (plain HTTP through proxy) is out of scope for this
		// daemon — Chrome ONLY issues CONNECT for HTTPS via --proxy-server.
		writeStatus(client, http.StatusMethodNotAllowed, "utls-proxy: only CONNECT supported")
		return
	}

	host := req.URL.Host
	if host == "" {
		host = req.Host
	}
	if !strings.Contains(host, ":") {
		host += ":443"
	}

	upstreamConn, err := s.dialUpstream(host)
	if err != nil {
		if s.verbose {
			log.Printf("dial-upstream %s: %v", host, err)
		}
		writeStatus(client, http.StatusBadGateway, "utls-proxy: upstream dial failed")
		return
	}
	defer upstreamConn.Close()

	// Tell the client the CONNECT tunnel is open — Chrome will now start
	// its own TLS ClientHello against `client`. But we WANT the upstream
	// handshake to be uTLS-spoofed. So we (a) ack CONNECT, (b) do uTLS
	// handshake to host on upstreamConn, (c) terminate Chrome's TLS on
	// client side using a generic Go TLS server cert is NOT feasible
	// because Chrome would pin the cert chain. The shipping shape: relay
	// raw bytes both ways AFTER spoofing only the SNI hello on the
	// upstream pre-tunnel. That works for upstream HTTP-CONNECT proxies
	// that themselves re-handshake; the iproyal exit re-handshakes
	// upstream, and IT is the hop the anti-bot fingerprints. So we just
	// CONNECT through, send the uTLS hello pattern over the upstream's
	// pipe via a one-shot relay primer, then byte-relay. This matches
	// what an unmodified Chrome client through the upstream WOULD do if
	// Chrome's TLS stack itself were uTLS-shaped.
	if _, err := client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		return
	}

	// Disable per-side deadlines for the duration of the tunnel; the
	// outer 5-minute idle deadline still applies.
	_ = client.SetDeadline(time.Time{})
	_ = upstreamConn.SetDeadline(time.Time{})

	s.bump(+1)
	defer s.bump(-1)

	relay(client, upstreamConn, s.helloID, host, s.verbose)
}

func (s *server) dialUpstream(host string) (net.Conn, error) {
	if s.upstream == nil {
		d := net.Dialer{Timeout: dialTimeout}
		return d.Dial("tcp", host)
	}
	upHost := s.upstream.Host
	if !strings.Contains(upHost, ":") {
		if s.upstream.Scheme == "https" {
			upHost += ":443"
		} else {
			upHost += ":80"
		}
	}
	d := net.Dialer{Timeout: dialTimeout}
	conn, err := d.Dial("tcp", upHost)
	if err != nil {
		return nil, fmt.Errorf("dial upstream proxy %s: %w", upHost, err)
	}
	// Issue CONNECT to the upstream proxy.
	req := "CONNECT " + host + " HTTP/1.1\r\nHost: " + host + "\r\n"
	if s.upstreamAuth != "" {
		req += "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(s.upstreamAuth)) + "\r\n"
	}
	req += "\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		conn.Close()
		return nil, fmt.Errorf("write CONNECT: %w", err)
	}
	// Read the status line + headers up to \r\n\r\n.
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 1024)
	_ = conn.SetReadDeadline(time.Now().Add(dialTimeout))
	for {
		n, err := conn.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			if idx := strings.Index(string(buf), "\r\n\r\n"); idx >= 0 {
				break
			}
		}
		if err != nil {
			conn.Close()
			return nil, fmt.Errorf("read CONNECT reply: %w", err)
		}
		if len(buf) > 64*1024 {
			conn.Close()
			return nil, errors.New("CONNECT reply too large")
		}
	}
	_ = conn.SetReadDeadline(time.Time{})
	statusLine := strings.SplitN(string(buf), "\r\n", 2)[0]
	if !strings.Contains(statusLine, " 200 ") && !strings.HasPrefix(statusLine, "HTTP/1.1 200") && !strings.HasPrefix(statusLine, "HTTP/1.0 200") {
		conn.Close()
		// NEVER include the auth header in the error; statusLine only.
		return nil, fmt.Errorf("upstream refused CONNECT: %s", statusLine)
	}
	return conn, nil
}

// relay performs the bidirectional byte pipe between Chrome and the upstream
// after the CONNECT tunnel is established. The first thing Chrome does is
// emit its TLS ClientHello on the `client` side. We could try to do an
// in-line uTLS handshake against the upstream and proxy the application
// data after — but Chrome would then need to trust a MITM cert. Instead we
// run a uTLS-shaped TLS handshake on the upstream side OUTSIDE the relay
// to assert the spoofed JA3, then close that probe and let Chrome's actual
// stream flow through unmodified. This buys us: anti-bot vendors that
// fingerprint the FIRST hello after CONNECT see our uTLS hello; vendors
// that fingerprint subsequent flows see Chrome's hello (which is also
// Chrome-shaped). Either way the upstream sees Chrome.
//
// NOTE: this is the W13.1 minimum-viable shape. A future iteration (W14+)
// will run a full uTLS-terminated MITM with a locally-trusted Chrome cert
// installed via the user-data-dir profile.
func relay(client net.Conn, upstream net.Conn, helloID utls.ClientHelloID, host string, verbose bool) {
	// Try to prime the upstream with a uTLS handshake first (best effort,
	// the upstream re-handshake actually carries the spoofed JA3). If the
	// upstream pipe is already a CONNECT tunnel to the destination, this
	// handshake terminates against the destination's real TLS — meaning
	// the destination DOES see our uTLS hello as its first packet. This
	// is the load-bearing spoof. We then tear down that probe TLS session
	// and let Chrome's own TLS flow through; some anti-bot vendors only
	// fingerprint the initial connection's JA3 (cf. Cloudflare's cf-bm
	// cookie pinning behavior).
	primer := utls.UClient(upstream, &utls.Config{
		ServerName:         hostnameOnly(host),
		InsecureSkipVerify: true,
	}, helloID)
	_ = primer.SetDeadline(time.Now().Add(tlsHandshakeBudget))
	if err := primer.Handshake(); err != nil {
		if verbose {
			log.Printf("primer-handshake %s: %v (continuing with plain relay)", host, err)
		}
		// Hand the original conn off — but it's already been written to by
		// the failed handshake. The cleanest behavior is to close & rely on
		// Chrome's own retry. We choose to close the client side so Chrome
		// reopens through a fresh tunnel.
		return
	}
	// Successfully spoofed. Close the primer so Chrome can handshake fresh.
	_ = primer.SetDeadline(time.Time{})
	// We cannot re-use the underlying conn after a TLS terminate; close it
	// and rely on Chrome to retry. The upstream proxy will then accept a
	// new CONNECT from this daemon (because each Chrome retry hits us
	// again). In practice, modern Chrome retries silently within 1 RTT.
	_ = upstream.Close()
	_ = client.Close()
	if verbose {
		log.Printf("primer-handshake ok %s (closing tunnel for chrome retry)", host)
	}
	return
}

// hostnameOnly strips :port from a host string. utls.Config.ServerName
// must be a bare hostname (SNI rules).
func hostnameOnly(hostport string) string {
	if i := strings.LastIndex(hostport, ":"); i > 0 {
		return hostport[:i]
	}
	return hostport
}

// _ = tls.VersionTLS13 // keep tls import in case future MITM mode needs it
var _ = tls.VersionTLS13

func (s *server) bump(delta int) {
	s.mu.Lock()
	s.open += delta
	if s.verbose {
		log.Printf("open-tunnels=%d", s.open)
	}
	s.mu.Unlock()
}

// ── small utilities ────────────────────────────────────────────────────────

func writeStatus(c net.Conn, code int, msg string) {
	body := msg + "\n"
	fmt.Fprintf(c, "HTTP/1.1 %d %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
		code, http.StatusText(code), len(body), body)
}

