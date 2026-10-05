# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Printventory is an Electron-based desktop application for managing 3D printing model collections (STL, 3MF files). It supports multiple deployment modes:
- **Desktop app** (Windows, macOS, Linux)
- **Server mode** (`--server` flag) - HTTP server accessible via browser on local network
- **Docker container** - Linux server mode deployment

## Build & Test Commands

```bash
# Run the app
npm start                    # Desktop mode
npm start:server            # Server mode (port 5000)

# Build
npm run build               # Windows + macOS
npm run build:mac           # macOS only
npm run build:win           # Windows only
npm run build:linux         # Linux AppImage
npm run build:docker        # Docker image preparation

# Testing
npm test                    # Playwright E2E tests (all)
npm test:full               # Full app E2E test
npm run test:bundle         # Bundle key extraction tests
npm run test:mcp            # MCP server tests
npm run test:folder-tree    # Folder tree library tests
npm run test:slicer-detect  # Slicer detection tests
npm run test:dedup-stress   # Large library stress test (50K+ models)
```

Unit tests are run directly with Node (`node <test-file>.test.js`). Playwright is used for E2E tests (`tests/*.spec.js`).

## Architecture

### Main Entry Points

- **`main.js`** (14K LOC) - Electron main process: app lifecycle, IPC handlers, database (better-sqlite3), background workers, Express HTTP server (server mode)
- **`renderer.js`** (25K LOC) - Primary UI renderer: DOM management, model grid, search/filter/tagging, 3D preview integration
- **`preload.js`** - Electron context bridge for secure IPC
- **`preview.js`** - Three.js 3D model visualization

### IPC Communication Pattern

Main process registers handlers, renderer invokes through context bridge:
```javascript
// Main process
ipcMain.handle('channel-name', async (event, args) => { ... })

// Renderer (via preload)
window.electron.invoke('channel-name', args)
```

### Key Subsystems

**3D Preview & Rendering:**
- `preview.js` - Three.js scene setup, lighting, materials
- `preview-3mf-worker-node.js` - Worker thread for 3MF mesh parsing
- `threemf-loader-simple.js`, `threemf-mesh-extract.js` - 3MF format parsing
- `vendor/` - Three.js, STLLoader, 3MFLoader, OrbitControls, Fuse.js

**File Scanning & Handling:**
- `scan-worker.js` - Background directory scanner (Worker thread)
- `scan-skip.js` - Configurable skip patterns
- `folder-tree-lib.js` - Folder hierarchy management
- `zip-extract.js` - ZIP archive handling
- `bundle-keys.js` - ZIP bundle identity derivation (path.zip::entry format)

**Search & Query:**
- `search.js` - Full-text search with Fuse.js
- `query-builder.js` - Advanced filter DSL

**Server Mode:**
- `server-bridge.js` - WebSocket bridge replacing Electron IPC for browser clients
- `server-tls.js` - TLS certificate handling
- `mcp-server.js` - Model Context Protocol HTTP endpoint at `/mcp`

**Feature Modules:**
- `aitagging.js` - OpenAI-powered tag suggestions
- `slicer.js`, `slicer-detect.js`, `slicer-launch.js` - Slicer integration
- `printer-manager.js`, `filament.js` - Printer/filament management
- `print-events.js`, `print-history.js` - Print tracking
- `extension-inbox.js` - Chrome extension integration
- `spoolman.js` - Spoolman API integration (read-only)

### Build Configuration

- **electron-builder** for cross-platform packaging
- ASAR packaging with selective unpacking for native modules and workers
- Output directory: `dist/`
- Platform-specific scripts in `scripts/`

### Environment Variables

- `PRINTVENTORY_PREVIEW_3MF_MAX_FILE_SIZE_MB` - Max file size for 3MF preview
- `PRINTVENTORY_PREVIEW_3MF_WORKER_MEMORY_MB` - Worker memory limit
- `PRINTVENTORY_PREVIEW_3MF_MAX_DISK_CACHE_MB` - Preview disk cache limit
- `PRINTVENTORY_PORT` - Server mode port (default 5000)
- `PRINTVENTORY_TLS_*` - TLS certificate configuration

### Database

Uses `better-sqlite3` for synchronous SQLite access. Schema includes models, tags, filaments, print history, library paths. Database location:
- Windows: `%LOCALAPPDATA%\Printventory`
- macOS: `~/Library/Application Support/Printventory`

### File Format Support

- STL, 3MF (primary)
- Pluggable preview extractors: LYS, F3D, Chitubox, Voxl
- ZIP bundles with `path.zip::entry` format for nested files

## Code Organization Notes

- Large monolithic files for main processes (main.js, renderer.js)
- Feature-specific utility modules as separate files
- State managed via window object (UI), database (persistent), and Map/Set caches
- Console logs use `[Component]` prefix for tracing
- Test utilities shared via `tests/test-utils.js`
