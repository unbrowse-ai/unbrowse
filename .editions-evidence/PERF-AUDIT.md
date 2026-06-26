# PERF AUDIT — https://www.unbrowse.ai/

Run: 2026-06-25T12:26:46.420Z
Conditions: emulated mobile viewport (390x844), 4x CPU throttle, ~4G network (1.6Mbps / 150ms RTT), Chrome headless.

## Core Web Vitals (cold load, throttled)

| Metric | Value | Budget | Verdict |
|---|---|---|---|
| HTTP status | 200 | 200 | PASS |
| TTFB | 1745 ms | <600 ms | POOR |
| FCP | 2960 ms | <1800 ms | POOR |
| LCP | 3976 ms | <2500 ms | POOR |
| CLS | 0.000 | <0.1 | PASS |
| TBT (proxy) | 103 ms | <200 ms | PASS |
| Long tasks | 3 (max 141 ms) | <5 | PASS |
| Time to networkidle2 | 12168 ms | <5000 ms | POOR |

## Bundle / network

- Requests: **86**
- Total transferred: **1131.3 KB**
- JS total (encoded): **334.2 KB** across 15 listed chunks
- CSS total: 22.9 KB
- Fonts: 4 files, 82.5 KB
- Images: 12

### Top 10 JS chunks (encoded KB)
1. 137.5 KB — /_next/static/chunks/107eebbadf9a906d.js
2. 68.8 KB — /_next/static/chunks/6ad2c7d531fe35b7.js
3. 31.7 KB — /_next/static/chunks/8ff8407765861fd3.js
4. 20.8 KB — /_next/static/chunks/97b94bbbc6e274cf.js
5. 13.7 KB — /_next/static/chunks/5278315fa76dec3d.js
6. 11.4 KB — /beacon.min.js/v833ccba57c9e4d2798f2e76cebdd09a11778172276447
7. 8 KB — /_next/static/chunks/36511a7fd645ea81.js
8. 7.8 KB — /_next/static/chunks/44c6e0dba42dd4ca.js
9. 7.6 KB — /_next/static/chunks/9eb502b89e79803d.js
10. 6.4 KB — /_next/static/chunks/aca54f13ad64704c.js

### Top images
1. 285.8 KB — /images/android-hand-nobg.png
2. 202 KB — /images/human-hand-nobg.png
3. 46 KB — /photo-1540959733332-eab4deabeeaf?auto=format&fit=crop&w=400&q=80
4. 27.7 KB — /photo-1499856871958-5b9627545d1a?auto=format&fit=crop&w=400&q=80
5. 5.5 KB — /nvidia-inception.svg
6. 4.7 KB — /partner-uprock.png

## Scroll jank (chapter-by-chapter scrollBy)

| Metric | Lenis ON | Lenis OFF |
|---|---|---|
| Frames captured | 332 | n/a |
| Effective FPS | 60.0 | n/a |
| Avg frame ms | 16.7 | n/a |
| Dropped (>20ms) | 4 | n/a |
| Bad (>33ms) | 0 | n/a |
| Worst frame ms | 25 | n/a |

Frame histogram (Lenis ON): {">16ms":331,">20ms":4,">33ms":0,">50ms":0,">100ms":0}

Lenis mounted: false (has destroy: false)

## INP proxy (top slow events)
1. pointerover — 56.0 ms
2. pointerenter — 56.0 ms
3. pointerenter — 56.0 ms
4. pointerenter — 56.0 ms
5. pointerenter — 56.0 ms
6. pointerenter — 56.0 ms
7. pointerenter — 56.0 ms
8. pointerenter — 56.0 ms

### Hover/click latencies
- `a[href*='install']` → 139.5 ms
- `button:not([disabled])` → 85.8 ms
- `[role='tab']` → 100.8 ms

## Layout shift offenders (top 5)
_no shifts observed_

## Images missing dimensions (potential CLS)
- 7 of 9 images lack explicit width/height
1. https://www.unbrowse.ai/images/human-hand-nobg.png (natural 1360x731, rendered 246x388)
2. https://www.unbrowse.ai/images/android-hand-nobg.png (natural 1167x976, rendered 215x338)
3. https://www.unbrowse.ai/nvidia-inception.svg (natural 300x129, rendered 130x56)
4. https://www.unbrowse.ai/partner-crossmint.svg (natural 150x28, rendered 129x24)
5. https://www.unbrowse.ai/partner-moonpay.svg (natural 300x66, rendered 109x24)

## Fonts loaded
- Fonetika 400 normal — status=unloaded display=swap
- Google Sans Display Fallback normal normal — status=unloaded display=auto
- Cormorant Garamond 400 italic — status=unloaded display=swap
- Cormorant Garamond 400 italic — status=unloaded display=swap
- Cormorant Garamond 400 italic — status=unloaded display=swap
- Cormorant Garamond 400 italic — status=unloaded display=swap
- Cormorant Garamond 400 italic — status=unloaded display=swap
- Cormorant Garamond 500 italic — status=unloaded display=swap
- Cormorant Garamond 500 italic — status=unloaded display=swap
- Cormorant Garamond 500 italic — status=unloaded display=swap
- Cormorant Garamond 500 italic — status=unloaded display=swap
- Cormorant Garamond 500 italic — status=unloaded display=swap
- Cormorant Garamond 400 normal — status=unloaded display=swap
- Cormorant Garamond 400 normal — status=unloaded display=swap
- Cormorant Garamond 400 normal — status=unloaded display=swap
- Cormorant Garamond 400 normal — status=unloaded display=swap
- Cormorant Garamond 400 normal — status=unloaded display=swap
- Cormorant Garamond 500 normal — status=unloaded display=swap
- Cormorant Garamond 500 normal — status=unloaded display=swap
- Cormorant Garamond 500 normal — status=unloaded display=swap
- Cormorant Garamond 500 normal — status=unloaded display=swap
- Cormorant Garamond 500 normal — status=unloaded display=swap
- Cormorant Garamond 600 normal — status=unloaded display=swap
- Cormorant Garamond 600 normal — status=unloaded display=swap
- Cormorant Garamond 600 normal — status=unloaded display=swap
- Cormorant Garamond 600 normal — status=unloaded display=swap
- Cormorant Garamond 600 normal — status=unloaded display=swap
- Cormorant Garamond 700 normal — status=unloaded display=swap
- Cormorant Garamond 700 normal — status=unloaded display=swap
- Cormorant Garamond 700 normal — status=unloaded display=swap
- Cormorant Garamond 700 normal — status=unloaded display=swap
- Cormorant Garamond 700 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=loaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=unloaded display=swap
- Google Sans 400 normal — status=loaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=loaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=unloaded display=swap
- Google Sans 500 normal — status=loaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=loaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=unloaded display=swap
- Google Sans 700 normal — status=loaded display=swap
- Google Sans Display 400 normal — status=unloaded display=swap
- Google Sans Display 400 normal — status=unloaded display=swap
- Google Sans Display 400 normal — status=unloaded display=swap
- Google Sans Display 400 normal — status=unloaded display=swap
- Google Sans Display 400 normal — status=loaded display=swap
- Google Sans Display 500 normal — status=unloaded display=swap
- Google Sans Display 500 normal — status=unloaded display=swap
- Google Sans Display 500 normal — status=unloaded display=swap
- Google Sans Display 500 normal — status=unloaded display=swap
- Google Sans Display 500 normal — status=unloaded display=swap
- Google Sans Display 700 normal — status=unloaded display=swap
- Google Sans Display 700 normal — status=unloaded display=swap
- Google Sans Display 700 normal — status=unloaded display=swap
- Google Sans Display 700 normal — status=unloaded display=swap
- Google Sans Display 700 normal — status=loaded display=swap
