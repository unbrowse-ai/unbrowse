# Reverse Engineer - Frontend App

A production-ready React app for the Unbrowse marketplace, skill detail explorer, docs, analytics, and earnings.

## Features

- **Marketplace** - Browse/search skills with endpoint stats
- **Skill Detail** - Endpoint radar with working endpoint filtering
- **Docs** - Product and API usage docs
- **Analytics** - Marketplace metrics dashboard
- **Earnings** - FDRY stats, balances, leaderboard

## Tech Stack

- **React 18.3** - UI library
- **React Router 6.30** - Client-side routing
- **Vite 5.4** - Build tool and dev server
- **CSS3** - Custom styling system with CSS variables

## Getting Started

### Prerequisites

- Node.js 18+ or compatible runtime
- pnpm (recommended) or npm

### Installation

```bash
# Install dependencies
pnpm install
```

### Development

```bash
# Start the dev server
pnpm dev
```

The app will be available at [http://localhost:3000](http://localhost:3000)

### Build

```bash
# Build for production
pnpm build
```

The production build will be output to the `dist` directory.

### Preview Production Build

```bash
# Preview the production build locally
pnpm preview
```

## Self-Hosting (Docker)

This frontend is Vite + React (not Next.js). Deploy as a static bundle behind nginx.

### Build and run locally

```bash
docker build -f packages/web/Dockerfile -t unbrowse-web:local packages/web
docker run --rm -p 3000:80 unbrowse-web:local
```

App is available at [http://localhost:3000](http://localhost:3000).

## GitHub Actions SSH Deploy

Workflow: `/Users/lekt9/Projects/unbrowse-openclaw/.github/workflows/deploy-web-ssh.yml`

Triggers:
- `push` to `staging`, `prod`, `production`, or `main` (web changes)
- manual `workflow_dispatch`

Configure GitHub Environment secrets (`staging` / `production`):

- `DEPLOY_HOST` - SSH host (e.g. `1.2.3.4`)
- `DEPLOY_USER` - SSH user
- `DEPLOY_SSH_KEY` - private key for deploy user
- `DEPLOY_PORT` - optional, default `22`
- `DEPLOY_PATH` - optional, default `/opt/unbrowse-web`
- `DEPLOY_CONTAINER` - optional, default `unbrowse-web`
- `DEPLOY_PUBLIC_PORT` - optional, default `3000`
- `DEPLOY_ROUTE_MODE` - optional, `host-port` (default) or `network`
- `DEPLOY_DOCKER_NETWORK` - required when `DEPLOY_ROUTE_MODE=network` (shared docker network name)
- `DEPLOY_NETWORK_ALIAS` - optional network alias in shared network (default `unbrowse-web`)
- `DEPLOY_KNOWN_HOSTS` - optional, full known_hosts entry (recommended)
- `DEPLOY_JUMP_HOST` - optional bastion host for private targets
- `DEPLOY_JUMP_USER` - optional bastion SSH user (defaults to `DEPLOY_USER`)
- `DEPLOY_JUMP_PORT` - optional bastion SSH port (default `22`)

Remote server requirements:
- Docker installed and available for the deploy user
- Port (`DEPLOY_PUBLIC_PORT`) open on server/firewall

### Using Nginx Proxy Manager / Shared Docker Network

If Nginx Proxy Manager runs in Docker on the same host, use shared-network mode:

- `DEPLOY_ROUTE_MODE=network`
- `DEPLOY_DOCKER_NETWORK=<your-shared-network>` (e.g. `proxy`)
- `DEPLOY_NETWORK_ALIAS=unbrowse-web`

In this mode, no host port mapping is created. Point Nginx Proxy Manager upstream to:

- Host: `unbrowse-web` (or your alias)
- Port: `80`

## Project Structure

```
app/
├── src/
│   ├── pages/
│   │   ├── Skills.jsx             # Marketplace home
│   │   ├── Search.jsx             # Search results
│   │   ├── SkillDetail.jsx        # Skill detail + endpoint radar
│   │   ├── Docs.jsx               # Documentation
│   │   ├── Analytics.jsx          # Analytics dashboard
│   │   └── Earnings.jsx           # FDRY earnings views
│   ├── components/
│   │   ├── Layout.jsx             # Main app shell/nav
│   │   └── FdryBalance.jsx        # FDRY badge in nav
│   ├── lib/
│   │   └── api-base.js            # VITE_API_BASE URL helper
│   ├── App.jsx                    # Root component with routing
│   ├── main.jsx                   # Entry point
│   └── index.css                  # Complete styling system
├── public/
├── index.html
├── vite.config.js                 # Vite configuration with proxy
└── package.json
```

## API Proxy Configuration

The dev server is configured to proxy the following routes to `http://localhost:4111`:

- `/admin/analytics/*` - Analytics endpoints
- `/health` - Health check endpoint

Update the proxy configuration in `vite.config.js` if your backend runs on a different port.

## Features by Page

### Marketplace
- Browse skills by popularity
- Filter free/paid and search by query/service/domain
- Endpoint counts shown on cards

### Skill Detail
- Endpoint radar with status/method/path filters
- Shows only working endpoints in explorer
- Skill install/replay command quickstart

### Analytics
- Marketplace-level stats and time series
- Top skills and retention views

### Earnings
- FDRY balance/distributions/leaderboard

## Environment Variables

- `VITE_API_BASE` (optional, recommended): backend base URL for marketplace/admin/FDRY calls.
- Example: `VITE_API_BASE=https://staging-index.unbrowse.ai`
- If unset, the app uses same-origin relative paths (works with local proxy/reverse proxy setups).

## Security Notes

- No frontend login flow in this app. Access control is enforced by backend route policies where applicable.

## Contributing

When adding new features:
1. Create new page components in `src/pages/`
2. Add routes in `App.jsx`
3. Update nav in `components/Layout.jsx`
4. Use existing CSS variables/patterns in `index.css`
5. Use `lib/api-base.js` for all backend calls

## License

Proprietary
