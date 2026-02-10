# Reverse Engineer - Frontend App

A production-ready React application for managing API abilities, credentials, API keys, and analytics.

## Features

- **Google OAuth Authentication** - Secure login with Google accounts
- **HAR File Ingestion** - Upload HAR files to automatically extract API calls
- **Single API Ingestion** - Manually add individual API endpoints
- **Ability Management** - View, search, filter, favorite, publish, and delete abilities
- **Credentials Storage** - Manage client-encrypted credentials for API authentication
- **API Key Management** - Create, list, and revoke API keys for programmatic access
- **Analytics Dashboard** - Track usage statistics and performance metrics

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

## Project Structure

```
app/
├── src/
│   ├── context/
│   │   └── AuthContext.jsx       # Authentication state management
│   ├── pages/
│   │   ├── Login.jsx              # Google OAuth login page
│   │   ├── Dashboard.jsx          # Main layout with sidebar navigation
│   │   ├── Home.jsx               # Dashboard home with stats
│   │   ├── Abilities.jsx          # Ability management
│   │   ├── Ingestion.jsx          # HAR/API ingestion
│   │   ├── Credentials.jsx        # Credential management
│   │   ├── ApiKeys.jsx            # API key management
│   │   └── Analytics.jsx          # Analytics dashboard
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

- `/auth/*` - Authentication endpoints
- `/my/*` - User-scoped endpoints
- `/ingest/*` - Ingestion endpoints
- `/abilities/*` - Ability endpoints
- `/analytics/*` - Analytics endpoints
- `/health` - Health check endpoint

Update the proxy configuration in `vite.config.js` if your backend runs on a different port.

## Features by Page

### Login
- Google OAuth authentication
- Clean, modern login UI

### Home Dashboard
- Overview statistics (total abilities, executions, success rate, avg execution time)
- Quick action cards for common tasks

### Abilities
- View all your API abilities
- Search by name, description, or domain
- Filter by favorites or published status
- View detailed information (headers, params, schema)
- Favorite/unfavorite abilities
- Publish abilities to share with others
- Delete abilities

### Ingestion
- Upload HAR files for automatic API extraction
- Manually add single API endpoints
- Support for all HTTP methods (GET, POST, PUT, PATCH, DELETE)
- JSON headers and body configuration

### Credentials
- View credentials grouped by domain or in list view
- Client-side encryption (AES-256-GCM)
- Export credentials for backup
- Delete credentials by domain or individually
- Zero-knowledge architecture (server never sees plaintext)

### API Keys
- Create API keys with optional expiration and rate limits
- View key metadata (created, expires, last used, usage count)
- Revoke keys
- Copy key to clipboard
- Usage examples in curl and JavaScript

### Analytics
- User statistics (abilities, executions, success rate, execution time)
- Top abilities by usage
- Popular public abilities
- Recent activity timeline
- Detailed ability execution history

## Environment Variables

No environment variables are required for the frontend. All configuration is done through the backend API.

## Security Notes

- All credentials are encrypted CLIENT-SIDE before being sent to the server
- The app uses AES-256-GCM encryption with SHA-256 key derivation
- Zero-knowledge architecture: the server stores only encrypted values
- API keys support expiration dates and rate limits
- All requests use session-based authentication with cookies

## Browser Extension

To upload credentials, you'll need the companion browser extension which handles:
- Automatic credential capture from browsing sessions
- Client-side encryption before upload
- Automatic decryption when executing abilities

## Contributing

When adding new features:
1. Create new page components in `src/pages/`
2. Add routes to `Dashboard.jsx`
3. Update navigation in `Dashboard.jsx`
4. Use the existing CSS classes from `index.css`
5. Follow the established patterns for API calls and error handling

## License

Proprietary
