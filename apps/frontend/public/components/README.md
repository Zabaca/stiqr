# Stiqr Component Library

This directory contains React components for the Stiqr platform, including both built-in components and CDN-based library demonstrations.

## Component Types

### Built-in Components (URL-Only Architecture)
Self-contained components using `window.React` for the unified URL-only loading system:

- **animated-button.js** - Button with hover animations and click effects
- **simple-counter.js** - Counter with increment, decrement, and reset buttons

### CDN Library Demonstrations
Components that demonstrate loading UI libraries from published NPM packages via CDN using ESM imports.

All CDN components use **top-level imports** (production style) to load NPM packages directly from CDN:

### Icon Libraries
- **lucide-icons-demo.js** - Lucide React icons (1000+ icons)
- **lucide-icons-production.js** - Production example with top-level import
- **react-feather-demo.js** - React Feather icons (287 icons)
- **react-icons-demo.js** - Multiple icon sets (Font Awesome, Material Design, etc.)

### UI Components
- **confetti-button.js** - Canvas confetti effects library

## Key Features

- ✅ **Real NPM packages** - All components load actual published packages
- ✅ **Top-level imports** - No dynamic loading, immediate availability
- ✅ **External React** - Uses `?external=react` flag to avoid bundling React
- ✅ **React 19 compatible** - Works with the latest React version
- ✅ **No build step** - Direct ESM imports from CDN

## Import Pattern

All components follow this pattern:
```javascript
import React from 'react';
import * as Icons from 'https://esm.sh/package-name@version?external=react';
```

This ensures:
- Components are available immediately (no loading state needed)
- Better TypeScript support (if using TS)
- Module loaded once at parse time
- Better for production applications

## Creating New Built-in Components

### Required Format for Built-in Components

All built-in components must use `window.React` and be ES modules:

```javascript
/**
 * Component Name
 * 
 * Brief description and features.
 * 
 * @category UI|Data|Forms|Charts|Layout|Utility
 * @tags tag1, tag2, tag3
 * @author Author Name
 * @version 1.0.0
 */

const { useState, useEffect } = window.React;

export default function ComponentName() {
  // Use window.React.createElement instead of JSX
  return window.React.createElement('div', {
    style: { /* inline styles */ }
  }, 'Component content');
}
```

### Adding to Component Manifest

Update `src/data/componentManifest.ts`:

```typescript
{
  id: 'component-id',
  name: 'Component Name',
  description: 'Component description',
  category: 'UI',
  tags: ['tag1', 'tag2'],
  source: 'builtin',
  url: '/components/component-file.js',
  author: 'Author Name',
  version: '1.0.0',
}
```

### Testing

1. Start dev server: `bun run dev`
2. Visit: `http://localhost:5173/components/your-component.js`
3. Test in Component Library