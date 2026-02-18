# Contributing to Command Post

Command Post is early-stage and the architecture is actively evolving. Contributions are welcome.

## Dev Environment Setup

```bash
# Requirements
# - Node.js >= 22.0.0
# - pnpm (see packageManager in root package.json for exact version)
# - tmux (for CLI package features)

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Type-check without emitting
pnpm typecheck
```

## Code Style

- **TypeScript strict mode** — all packages use strict TypeScript
- **Vitest** for all tests
- **tsup** for building packages
- **ESM-first** — all packages use `"type": "module"` with dual CJS/ESM exports

## Project Structure

```
packages/
  core/           # Types, inbox messaging, agent registry, utilities
  orchestration/  # Context daemon, memory snapshots, templates, lifecycle
  cli/            # Tmux session management, agent launching
```

Packages depend on each other via `workspace:*` — `@command-post/cli` and `@command-post/orchestration` both depend on `@command-post/core`.

## PR Process

1. Fork the repo and create a feature branch
2. Make your changes with tests
3. Run `pnpm test` and `pnpm typecheck` to verify
4. Submit a PR with a clear description of what and why

## Testing

```bash
# Run tests for a specific package
cd packages/core && pnpm test

# Watch mode
pnpm test:watch
```

## Architecture Notes

See [docs/architecture.md](docs/architecture.md) for an overview of packages, key concepts (context zones, message flow, governance hierarchy), and directory conventions.
