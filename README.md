# Command Post

A governance layer for multi-agent AI development systems. Command Post ensures AI agents build the right thing by providing context lifecycle management, specification compliance auditing, and structured inter-agent communication.

## Why Command Post?

When you run multiple AI agents on a single project, you need:

- **Context lifecycle management** — Agents hit context window limits. Command Post detects this via zero-cost transcript monitoring and orchestrates seamless replacement with memory transfer.
- **Governance** — Not every agent should be able to assign tasks or override status. Role-based message permissions enforce separation of concerns.
- **Compliance auditing** — Audit agents monitor events, detect anomalies, and generate reports without interfering with work.
- **Structured communication** — File-based inbox messaging with atomic writes, role validation, and lateral messaging controls.

## Architecture

Command Post is a monorepo with three packages:

### @command-post/core

The foundation — types, inbox messaging, agent registry, and utilities.

- **Inbox messaging** — File-based message passing with role-based send permissions (`ROLE_SEND_PERMISSIONS`), atomic writes, and file locking
- **Agent registry** — Track active agents, their roles, and lifecycle status
- **Validators** — JSON schema validation for all message and config types

### @command-post/orchestration

The governance engine — context monitoring, memory snapshots, and compliance.

- **Context Monitor Daemon** — External Node.js process that reads Claude Code JSONL transcripts to detect context exhaustion. Zero token cost, zero context overhead.
- **Memory Snapshot Protocol** — 4-step agent replacement: snapshot request, quality validation (with retry), spawn replacement, graceful shutdown. Implemented in `ReplacementCoordinator`.
- **Findings registry** — Track cross-cutting compliance findings across domains
- **Role templates** — Prompt templates for orchestrator, worker, audit, PO, security, and other agent roles
- **Degradation strategies** — Graceful context management (reduce, compress, offload)

### @command-post/cli

Agent session management via tmux.

- **Tmux session manager** — Create, monitor, and manage tmux sessions for agents
- **Agent runner** — Bash script generation for auto-continue loops
- **Status detection** — Determine agent state (idle/running/error/waiting)
- **Agent launcher** — Coordinate session creation, inbox setup, and Claude Code invocation

## Key Concepts

### Context Zones

| Zone | Usage | Behavior |
|------|-------|----------|
| Green | <60% | Normal operation |
| Yellow | 60-70% | Warning, begin degradation strategies |
| Red | >=70% | Critical, trigger Memory Snapshot Protocol |

The 70% threshold exists because Claude Code auto-compacts at ~80%. The protocol needs ~10% headroom to complete the snapshot before compaction destroys context.

### Governance Hierarchy

Three configurable tiers via `topology.yaml`:

- **pm-po-agent** — PM oversees PO, PO manages agents
- **po-agent** — PO directly manages agents
- **flat** — All agents at same level (for simple projects)

### Message Flow

```
Orchestrator ──task_assignment──> Worker
Worker ──task_update──> Orchestrator
Worker ──peer_message──> Worker (lateral, auto-CC orchestrator)
Audit Agent ──audit_report──> Orchestrator
Context Monitor ──lifecycle_command──> Any Agent
```

Role-based permissions are enforced at the send layer. Audit agents can only send `audit_report` and `escalation` — they cannot assign tasks or direct workers.

## Project Data Directory

Command Post stores project-level data under `<project-root>/.command-post/`:

```
.command-post/
├── agents/              # Per-agent directories (INSTRUCTIONS.md, workspace)
├── messages/            # Inbox message files (one JSON per agent)
├── memory-snapshots/    # Snapshot JSON files
├── events.jsonl         # Append-only event log
├── agent-registry.json  # Active agent tracking
├── topology.yaml        # Agent hierarchy configuration
└── spawn-requests/      # Pending spawn request files
```

## Getting Started

```bash
# Prerequisites: Node.js >= 22, pnpm, tmux
pnpm install
pnpm build
pnpm test
```

## Status

Early-stage. The core primitives (messaging, context monitoring, memory snapshots, agent spawning) are implemented and tested. The architecture is actively evolving.

## License

Apache-2.0 — see [LICENSE](LICENSE).
