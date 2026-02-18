# Command Post Architecture

## Overview
Command Post is a governance layer for multi-agent AI development systems. It ensures AI agents build the right thing by providing context lifecycle management, specification compliance auditing, and structured communication between agents.

## Package Structure

### @command-post/core
The foundation package providing:
- **Inbox messaging** — File-based message passing with role-based send permissions, atomic writes, and file locking
- **Agent registry** — Track active agents, their roles, and status
- **Type definitions** — AgentRole, InboxMessage, MessageType, and all shared interfaces
- **Utilities** — Atomic file writes, path resolution, JSON schema validation

### @command-post/orchestration
The governance engine providing:
- **Context monitoring daemon** — External process that reads Claude Code JSONL transcripts to detect context exhaustion. Zero token cost, zero agent awareness.
- **Memory Snapshot Protocol** — 4-step agent replacement: snapshot → validate quality → spawn replacement → shutdown original. Quality scoring with retry logic.
- **Findings registry** — Track cross-cutting compliance findings across domains
- **Role templates** — Prompt templates for all agent roles (orchestrator, worker, audit, etc.)
- **Degradation strategies** — Graceful context management (reduce → compress → offload)

### @command-post/cli
Agent session management providing:
- **Tmux session manager** — Create, monitor, and manage tmux sessions for agents
- **Agent runner** — Bash script generation for auto-continue loops
- **Status detection** — Determine agent state (idle/running/error/waiting)
- **Agent launcher** — Coordinate session creation, inbox setup, and Claude Code invocation

## Key Concepts

### Context Zones
- **Green** (<60%) — Normal operation
- **Yellow** (60-70%) — Warning, begin degradation strategies
- **Red** (≥70%) — Critical, trigger Memory Snapshot Protocol

The 70% threshold is critical because Claude Code auto-compacts at ~80%. The protocol needs ~10% headroom to complete the snapshot.

### Message Flow
```
Orchestrator ──task_assignment──→ Worker
Worker ──task_update──→ Orchestrator
Worker ──peer_message──→ Worker (lateral, auto-CC orchestrator)
Audit Agent ──audit_report──→ Orchestrator (ONLY these two types)
Audit Agent ──escalation──→ Orchestrator
Context Monitor ──lifecycle_command──→ Any Agent
```

### Role-Based Permissions
Agents can only send message types allowed by their role. Audit agents are restricted to `audit_report` and `escalation` — they cannot send task assignments or direct workers. This enforces separation of concerns at the communication layer.

### Memory Snapshot Quality
Snapshots are scored on 6 criteria. Minimum score of 0.6 required. If insufficient, the protocol retries with specific feedback. After 3 failures, force-handoff occurs to prevent the agent from hitting the compaction boundary.

### Governance Hierarchy
Three configurable tiers:
- **pm-po-agent** — PM oversees PO, PO manages agents
- **po-agent** — PO directly manages agents
- **flat** — All agents at same level (for simple projects)

## Directory Convention
Command Post stores project-level data under `<project-root>/.command-post/`:
```
.command-post/
├── agents/              # Per-agent directories (INSTRUCTIONS.md, workspace)
├── messages/            # Inbox message files (one JSON per agent)
├── memory-snapshots/    # Snapshot JSON files with -latest.json shortcuts
├── events.jsonl         # Append-only event log
├── agent-registry.json  # Active agent tracking
├── topology.yaml        # Agent hierarchy configuration
└── spawn-requests/      # Pending spawn request files
```
