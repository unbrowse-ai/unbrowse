# Frontend Deployment Blocker - React 19 / Next.js 16 Build Issue

## Status: 🔴 BUILD FAILED - Deployment Blocked

**Date:** May 4, 2026  
**Affected:** All frontend deployments since May 1, 2026  
**Root Cause:** React 19.1.5 + Next.js 16.1.5 compatibility issue during static generation

---

## Error Details

### Build Failure
```bash
$ bun run build
Error occurred prerendering page "/miners". Read more: https://nextjs.org/docs/messages/prerender-error
TypeError: Cannot read properties of null (reading 'useState')
    at f (.next/server/chunks/ssr/unbrowse-ecosystem_unbrowse_frontend_src_components_5f55aef3._.js:1:213)
Export encountered an error on /miners/page: /miners, exiting the build.
```

### Affected Pages
- `/miners` - TypeError: Cannot read properties of null (reading 'useState')
- `/_not-found` - Same error
- `/agent-fleet-economics` - Same error
- `/mine-the-internet` - Same error

### Error Location
The error originates from a chunk file: `unbrowse-ecosystem_unbrowse_frontend_src_components_5f55aef3._.js`

This suggests a component in `frontend/src/components/` is using React hooks (`useState`, `useContext`) in a way that breaks during SSR prerendering.

---

## Timeline

| Date | Event | Status |
|------|-------|--------|
| May 1, 2026 | Last successful deployment | ✅ Worked |
| May 1-4, 2026 | Dependency updates (bun.lock changes in commits a8391c55, 33b684f1) | ⚠️ Build broke |
| May 4, 2026 | Attempted redeploy | ❌ Failed |

---

## Current State

### Code Changes (Design Consistency)
✅ **Committed to main** (commit 3654e5fe):
- `frontend/src/app/login/page.tsx` - Updated with landing page design
- `frontend/src/app/dashboard/page.tsx` - Updated with landing page design
- `frontend/src/app/miners/page.tsx` - Hero section updated
- `frontend/src/app/blog/page.tsx` - Updated with landing page design
- `frontend/src/app/global-error.tsx` - REMOVED (was causing additional errors)

⚠️ **NOT YET UPDATED** (still need design consistency):
- `frontend/src/app/miners/sections.tsx` - 12+ instances of old styling
- `frontend/src/components/internet-evolution.tsx`
- `frontend/src/components/skill-card.tsx`
- `frontend/src/components/hero-cta.tsx`
- `frontend/src/components/api-key-generator.tsx`
- `frontend/src/components/docs-embed.tsx`
- `frontend/src/components/contributor-dashboard.tsx`
- And 10+ more component files

### Live Site Status
🔴 **Serving OLD cached code** (from May 1 or earlier)
- URL: https://www.unbrowse.ai
- Cache headers: `cache-control: s-maxage=8, stale-while-revalidate=2592000` (30 days stale)
- The live site can serve stale content for up to 30 days

---

## What Was Attempted

### 1. Removed global-error.tsx
- ❌ Didn't help - error persisted
- The error is in component files, not error handling

### 2. Tried `OPENNEXT_BUILD_ENV=server`
- ✅ Build compiled successfully
- ❌ Still failed during TypeScript/prerendering phase

### 3. Tried disabling ISR via Next config
- ❌ `output: "standalone"` didn't prevent prerendering errors

### 4. Created opennext.config.ts
- ❌ Incorrect import path, didn't help

### 5. Checked Cloudflare deployments
- Last successful: May 1, 2026 (version IDs starting with `05e1455f`)
- All recent deployments failed due to build errors

---

## Solutions to Try

### Immediate Fixes (Pick One)

#### Option A: Fix React Hook Usage During SSR
**Best long-term solution**

1. Identify the problematic component(s):
   ```bash
   # Find components using useState without proper null checks
   grep -r "useState()" frontend/src/components/*.tsx | grep -v "useState<"
   ```

2. Fix all hook calls to handle SSR:
   ```tsx
   // Instead of:
   const [state, setState] = useState()
   
   // Use:
   const [state, setState] = useState<Type>(initialValue)
   // Or wrap in useEffect for client-only state
   ```

3. Add proper null guards for client-only hooks:
   ```tsx
   const isClient = typeof window !== 'undefined'
   const [state, setState] = useState<Type | null>(isClient ? initialValue : null)
   ```

#### Option B: Disable Static Generation Completely
**Quick workaround**

Add to `frontend/next.config.ts`:
```ts
const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: { unoptimized: true },
  // Force all pages to be dynamic (no ISR/SSG)
  experimental: {
    dynamicIO: true,
  },
};
```

Or set in `opennext.config.ts`:
```ts
import type { OpenNextConfig } from "@opennextjs/cloudflare";

const config: OpenNextConfig = {
  default: {
    override: {
      incrementalCache: false,
      queue: false,
    },
  },
};

export default config;
```

#### Option C: Pin to Working Versions
**Rollback approach**

1. Check what React/Next versions worked on May 1:
   ```bash
   git show <may-1-commit>:frontend/package.json | grep -E "react|next"
   ```

2. Temporarily downgrade:
   ```json
   {
     "react": "19.0.0",
     "next": "15.0.0"
   }
   ```

#### Option D: Use Cloudflare Pages with Different Build Command
**Infrastructure workaround**

Modify `.github/workflows/deploy.yml`:
```yaml
- name: Deploy frontend worker
  run: |
    # Skip static generation, only build worker
    bun run build:worker  # Create this script
    OPEN_NEXT_DEPLOY=true wrangler deploy
```

---

## Deployment Steps (Once Build is Fixed)

After fixing the build issue:

```bash
# 1. Test build locally
cd frontend
bun run build

# 2. If build succeeds, deploy
bun run deploy:ci

# Or alternatively:
OPENNEXT_BUILD_ENV=server bun run build && OPEN_NEXT_DEPLOY=true wrangler deploy

# 3. Verify deployment
curl -sI https://www.unbrowse.ai | grep -i "cf-ray"

# 4. Check design consistency
agent-browser open https://www.unbrowse.ai/miners
agent-browser screenshot
```

---

## Testing Checklist (Before Deploying)

- [ ] Build succeeds: `bun run build`
- [ ] All pages render without errors:
  - [ ] `/` (landing)
  - [ ] `/login`
  - [ ] `/dashboard`
  - [ ] `/miners`
  - [ ] `/blog`
- [ ] Design is consistent (sharp corners, orange borders):
  - [ ] Check for `rounded-sm` instead of `rounded-2xl`
  - [ ] Check for `border-[var(--border)]` instead of `border-border`
  - [ ] Check for monospace `##` labels
- [ ] Theme toggle works (light/dark mode)
- [ ] Agent browser verification passes

---

## Additional Work Needed

### Design Consistency (Separate Task)
After fixing the build, these files still need updates:

1. **Priority: HIGH**
   - `frontend/src/app/miners/sections.tsx` - Core miners page sections
   - `frontend/src/components/hero-cta.tsx` - Used on landing page

2. **Priority: MEDIUM**
   - `frontend/src/components/skill-card.tsx`
   - `frontend/src/components/api-key-generator.tsx`
   - `frontend/src/components/docs-embed.tsx`

3. **Priority: LOW**
   - All other component files with `rounded-2xl` or `border-border`

**Pattern to apply:**
```tsx
// OLD:
<div className="rounded-2xl border border-border bg-surface">

// NEW:
<div className="rounded-sm border-[var(--border)] bg-surface-raised">

// Or landing page exact match:
<div className="rounded-sm border-[rgba(255,122,32,0.18)] bg-[#070503]/90">
```

---

## Contact / Ownership

- **Frontend Owner:** @lewis
- **Last Known Working:** May 1, 2026 deployment
- **This Document Created:** May 4, 2026
- **Git Commit:** 3654e5fe (design changes committed but not deployed)

---

## References

- Next.js 16 Docs: https://nextjs.org/docs
- React 19 Docs: https://react.dev
- OpenNext Cloudflare: https://opennext.js.org/cloudflare
- Cloudflare Workers Deployment: https://developers.cloudflare.com/workers/
- GitHub Actions Log: Check `.github/workflows/deploy.yml` job runs
