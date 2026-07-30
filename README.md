# Stiqr

An AI-powered visual canvas platform for creating interactive component-based interfaces.

## Overview

Stiqr is a next-generation whiteboard platform built as a monorepo that combines:
- 🎨 Visual canvas with drag-and-drop interface
- 🤖 AI-powered component generation
- 📦 Dynamic component loading with ESM-first architecture
- 🔧 Bit.dev integration for component management
- ⚡ Real-time preview and editing
- 🏗️ Monorepo architecture for scalable development

## Features

- **AI Component Generation**: Generate React components using natural language prompts with Cerebras AI
- **Visual Canvas**: ReactFlow-based node system for visual programming
- **Component Library**: Pre-built components ready to use (UI, Data, Forms, Charts, Layout, Utility)
- **ESM Architecture**: Modern ES modules with import maps for React singleton management
- **Live Preview**: See components render in real-time
- **URL Import**: Import ES modules directly from CDNs (esm.sh, unpkg, skypack)
- **Persistent Storage**: Auto-save to localStorage with export/import capabilities
- **Presentation Mode**: Toggle between edit and clean presentation views

## Project Structure

```
stiqr/
├── apps/
│   ├── frontend/          # React frontend application
│   └── backend/           # (Future) Backend services
├── packages/              # Shared packages
│   └── shared/           # (Future) Shared utilities
├── zbc.config.ts         # zbc project + environments
└── package.json          # Root monorepo package.json
```

## Getting Started

### Prerequisites

- Node.js 16+ (recommended: 20+)
- bun 1.2+

### Installation

```bash
# Clone the repository
git clone [repository-url] stiqr
cd stiqr

# Install all dependencies
bun install

# Start the frontend development server
bun run dev

# Or start specific apps
bun run --cwd apps/frontend dev
```

The frontend will be available at http://localhost:5173

### Environment Setup

1. **Copy the environment example file**:
   ```bash
   cp .env.example .env
   ```

2. **Get your API keys**:
   - **Cerebras API Key** (Required): Get from [Cerebras Cloud](https://cloud.cerebras.ai/)
     - Used for AI component generation
     - Free tier available with generous limits
   - **Groq API Key** (Optional): Get from [Groq Console](https://console.groq.com/)
     - Used for vision analysis and component screenshot refinement
     - Free tier available

3. **Configure your environment variables** in `.env`:
   ```bash
   # Required: Cerebras API key for AI component generation
   VITE_CEREBRAS_API_KEY=your-cerebras-api-key-here
   
   # Optional: Groq API key for vision analysis features
   VITE_GROQ_API_KEY=your-groq-api-key-here
   ```

4. **Load environment with direnv** (recommended):
   ```bash
   # Install direnv if not already installed
   # macOS: brew install direnv
   # Ubuntu: apt install direnv
   
   # Allow direnv in this directory
   direnv allow
   ```

   The environment will automatically load when you enter the directory.

### Build

```bash
# Build all apps
bun run build

# Build frontend only
bun run build

# Preview frontend production build
bun run preview
```

### Monorepo Commands

```bash
# Run command in specific app
bun run --cwd apps/frontend <command>


# Run command in all apps
bun run --cwd apps/<pkg> <command>

# Run parallel dev servers (when backend is added)
bun run dev
```

## Architecture

### Tech Stack
- **Frontend**: React 19 + TypeScript
- **Canvas**: React Flow (@xyflow/react)
- **AI**: Cerebras API (Llama models for fast generation)
- **Module System**: Native ES modules with browser import maps
- **Transpilation**: Babel standalone for runtime JSX compilation
- **Build**: Vite
- **Component Management**: Bit.dev (in progress)

### Key Architectural Features

1. **ESM-First Design**
   - All components are ES modules
   - Native browser import maps handle React singleton
   - Direct CDN imports without bundling

2. **React Singleton Pattern**
   - Prevents "Invalid Hook Call" errors
   - Import maps redirect all React imports to shim modules
   - Shims return the application's React instance

3. **Unified Component Pipeline**
   - Supports multiple component sources (AI, library, URL)
   - Smart caching with hash-based change detection
   - Automatic import fixing for missing React hooks

## Component Development

Components can be created through:

1. **AI Generation**: Natural language → Cerebras AI → React component
2. **Pre-built Library**: Choose from categorized components in `/public/components/`
3. **URL Import**: Import ES modules directly from CDN URLs
4. **Bit.dev Publishing**: Component management and versioning (coming soon)

### Component Structure

```javascript
// Standard ESM component format
import React, { useState } from 'react';

export default function MyComponent() {
  const [count, setCount] = useState(0);
  
  return (
    <div>
      <h1>Count: {count}</h1>
      <button onClick={() => setCount(count + 1)}>
        Increment
      </button>
    </div>
  );
}
```

## Deployment

Deploys go through [zbc](https://www.npmjs.com/package/@zabaca/zbc), which builds
`apps/frontend/dist` locally and ships it as a Cloudflare Worker: static assets
plus the two LLM proxy routes in `apps/frontend/worker/index.ts`.

```bash
bunx @zabaca/zbc apply production
```

Topology lives in `apps/frontend/wrangler.jsonc`, the instance in
`packages/infra/environments/production/web.ts`.

**stiqr.zabaca.com is still served by Netlify.** The Worker deploys to
`stiqr.james-99a.workers.dev` only, so it can be compared against the live site
before any DNS moves. The Netlify config (`apps/frontend/netlify.toml` and
`apps/frontend/netlify/functions/`) is deliberately still present and still the
thing serving production; it gets deleted in the same commit that flips DNS.

### The LLM proxies

`/.netlify/functions/cerebras` and `/.netlify/functions/groq` proxy Cerebras and
Groq so the API keys stay server-side. The Worker serves those exact paths, ugly
as they are, because the client hardcodes them: keeping them makes the Worker a
drop-in for Netlify, so the cutover is a pure DNS change. Renaming them to
`/api/*` is a follow-up that has to change the client, the Worker, and delete the
Netlify functions in one commit.

The keys are **not** configured on the Worker yet. Until they are, both routes
answer `500 {"error":"API key not configured"}`, which is what the Netlify
functions did with an unset key. They are set as `CEREBRAS_API_KEY` and
`GROQ_API_KEY` in this environment's sops-encrypted `secrets.yaml`, plus a
`workerSecrets` entry on the instance.

Note the `VITE_`-prefixed variants in `.env.example` are for **local development
only**, where Vite proxies directly to the upstream APIs. A `VITE_` variable is
inlined into the client bundle, so one must never hold a production key.

## Contributing

We welcome contributions! Please see our contributing guidelines for:
- Code style and standards
- Testing requirements
- Pull request process
- Issue reporting

## License

AGPL-3.0 License - see [LICENSE](LICENSE) file for details.

### Commercial Licensing

Stiqr is available under the GNU Affero General Public License v3.0 (AGPLv3). This license requires that if you modify Stiqr and offer it as a network service, you must provide the complete source code of your modifications to users.

For organizations that want to use Stiqr in proprietary applications or offer it as a managed service without open-sourcing their modifications, commercial licenses are available. Contact us for commercial licensing options.

## Support

- 📧 Email: [support email]
- 🐛 Issues: [GitHub Issues](https://github.com/[org]/stiqr/issues)
- 💬 Discussions: [GitHub Discussions](https://github.com/[org]/stiqr/discussions)

---

Built with ❤️ by [Zabaca](https://www.zabaca.com)