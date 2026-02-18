# Command Post

**The governance layer for multi-agent AI development.**

> AI agents build at machine speed. Command Post ensures they build the right thing.

Command Post is a specification compliance and lifecycle management system for coordinated AI agent teams. It sits above your execution tools — Claude Code, Codex, Cursor — and solves the problems they don't: agents drifting from requirements, losing accumulated knowledge at context boundaries, and producing work that nobody verifies against the original spec.

Built in TypeScript. Designed for Claude Code agents in tmux sessions. Informed by nuclear command and control principles where execution authority requires verification authority.

---

## The Problem

The AI coding landscape has an execution obsession. Every new tool makes agents faster. Nobody is making them more *governed*.

The result is predictable. A 2025 study of 567 Claude Code pull requests found that while 83.8% were accepted, 45% of those required human revision before merge — and the most common issues were logic errors, specification mismatches, and architectural violations that automated tests wouldn't catch ([Watanabe et al., 2025](https://arxiv.org/abs/2509.14745)). CodeRabbit's analysis of 470 real-world PRs found AI-generated code produces 1.7× more defects than human-written code, with logic and correctness issues 75% higher ([CodeRabbit, 2025](https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report)).

These numbers get worse with multi-agent systems. When three agents work in parallel on different features, specification drift compounds. Agent A makes an architectural assumption. Agent B contradicts it. Agent C builds on both. By the time a human reviews the output, the damage is structural.

And there's a second problem nobody talks about: **agent mortality**. AI agents have finite context windows. When an agent hits capacity, its accumulated knowledge — every architectural decision, every discovered edge case, every piece of reasoning — vanishes. The replacement agent starts fresh, repeating work and making contradictory decisions. In our testing, unmanaged context transitions cause 30–40% repeated work.

Command Post exists because bad requirements amplify at machine speed, and dead agents take institutional knowledge with them.

---

## What Command Post Does Differently

### 1. Zero-Cost Context Monitoring

Every other multi-agent framework that tracks context usage does it *inside* the agent, burning the very tokens it's trying to conserve. Command Post takes a fundamentally different approach: an external daemon that reads Claude Code's JSONL transcript files directly from disk.

```typescript
function getContextUsage(
  transcriptPath: string,
  maxContextTokens: number = 200_000
): ContextUsageReading | null
```

The daemon polls every 30 seconds, classifies each agent into green (<60%), yellow (60–70%), or red (≥70%) zones, detects usage trends, and triggers the Memory Snapshot Protocol before Claude Code's auto-compaction at ~80% erases the agent's conversation history.

Zero token cost. Zero agent awareness required. The agent just works; the daemon handles mortality.

### 2. Memory Snapshot Protocol

When an agent approaches context capacity, Command Post executes a 4-step replacement protocol:

```
1. Daemon → Agent Inbox:  "prepare_handoff"
2. Agent writes snapshot:   decisions, progress, edge cases, file state, next steps
3. Snapshot validated:      quality checklist (17 checks), retry if score < threshold
4. Replacement spawned:     fresh agent with full context inheritance
```

The critical difference from "just save your work" approaches: Command Post validates snapshot *quality*. A snapshot that says "working on auth" is worthless. A snapshot that captures *which* auth approach was chosen, *why* OAuth was rejected, *what* edge case was discovered in token refresh — that's continuity.

```typescript
interface PrdMemorySnapshot {
  agent_id: string;
  task_id: string;
  snapshot_timestamp: string;
  handoff_number: number;
  context_at_snapshot: number;
  state: {
    current_step: string;
    progress_summary: string;
    completion_estimate: string;
  };
  decisions?: Array<{
    decision: string;
    rationale: string;
    impact: string;
  }>;
  gotchas?: string[];
  files_state?: {
    completed: string[];
    in_progress: string[];
    not_started: string[];
  };
  next_steps: string[];
  dependencies_discovered?: string[];
}
```

If quality is insufficient, the coordinator sends a retry with specific findings about what's missing. After three failed attempts, it force-handoffs with whatever exists — because a partial snapshot beats no snapshot.

The naming convention tells the story: `worker-frontend-1` → `worker-frontend-1-r1` → `worker-frontend-1-r2`. Each replacement carries forward everything its predecessors learned.

### 3. PRD Audit Agents

Most teams verify AI output the same way they verify human output: code review after the fact. Command Post adds a dedicated governance layer — audit agents that continuously check work against the original specification.

Audit agents are read-only. They load the relevant PRD section and the worker's output, compare intent against implementation, and send structured compliance findings to the orchestrator. They don't communicate with workers directly. The orchestrator decides what feedback to relay.

This isn't a linter. A linter checks syntax. An audit agent checks whether the "user authentication" feature actually implements the authentication flow the PRD described, or whether the agent interpreted it as something else entirely.

### 4. Governance Hierarchy with Full-Capability Agents

Command Post enforces a communication hierarchy modeled on military command structures:

```
Human Operator
    ↓
Orchestrator (PM/PO)     ← approval gates, task assignment, spawns agents
    ↓           ↓
Workers (N)   Audit Agents
    ↕
  (peers)
```

Every agent is a full Claude Code instance in its own tmux session with complete tool access. No nested sub-agents sharing a parent's context window, no single points of failure. Each agent owns its own full context window and can be independently monitored, replaced, and lifecycle-managed. The PO can spawn additional workers or audit agents as project needs evolve.

Workers can message peer workers for cross-cutting concerns. Audit agents report only to the orchestrator. The orchestrator is the only role that can message everyone. Human approval gates are non-negotiable for architectural decisions, security choices, and integration points.

The inbox system enforces this at the protocol level — `sendMessage()` checks role-based permissions before delivery.

---

## Architecture

```
                ┌───────────────────────┐
                │    HUMAN OPERATOR     │
                │ (Dashboard/CLI/Direct)│
                └───────────┬───────────┘
                            │
                  ┌─────────▼─────────┐
                  │   Orchestrator    │
                  │   (PM/PO, tmux)   │
                  └───┬───────────┬───┘
                      │           │
            ┌─────────▼───┐ ┌────▼──────────┐
            │ Workers (N) │ │ Audit Agents  │
            │ (tmux each) │ │ (tmux each)   │
            └─────────────┘ └───────────────┘

  ┌─────────────────────────────────────────────┐
  │        Context Monitoring Daemon             │
  │  External process — monitors ALL agents      │
  │  Reads JSONL transcripts from disk           │
  │  Zero token cost · Zero agent awareness      │
  └─────────────────────────────────────────────┘
```

Each agent runs in an independent tmux session. No shared process. No hierarchical dependency chain. If one agent crashes, the others continue. The daemon monitors all of them from outside.

### Package Structure

```
command-post/
├── packages/
│   ├── core/            # Shared types, inbox system, config
│   ├── orchestration/   # Context daemon, snapshots, replacement protocol
│   ├── cli/             # Agent launching, tmux management
│   └── dashboard/       # Next.js UI (roadmap)
└── schemas/             # JSON schemas for validation
```

Both `cli` and `orchestration` depend on `core`. No circular dependencies. `core` has zero internal dependencies.

---

## Quick Start

```bash
git clone https://github.com/SeanFDZ/command-post.git
cd command-post
pnpm install
pnpm build
pnpm test   # 393 tests across 3 packages
```

Command Post is a TypeScript library. Import the packages directly:

```typescript
import { sendMessage, readInbox, writeMessage } from '@command-post/core';
import { ContextMonitorDaemon, ReplacementCoordinator } from '@command-post/orchestration';
import { SessionManager, AgentRunner } from '@command-post/cli';
```

A standalone CLI (`command-post init`, `command-post launch`, `command-post daemon start`) is on the roadmap.

---

## The Gap This Fills

| Category | Examples | What They Solve | What They Don't |
|---|---|---|---|
| Execution engines | Codex, Cursor, Claude Code | Running agents fast | Specification compliance |
| Orchestration frameworks | CrewAI, LangGraph, AutoGen | Agent coordination | Context lifecycle management |
| Context management | OpenAI Sessions, Google ADK | In-session memory | Zero-cost external monitoring |
| Action-level safety | Agent Gate, SentinelGate | What an agent *can do* | What an agent *should build* |
| **Command Post** | — | **Governance + lifecycle + compliance** | — |

Command Post is not a replacement for any of these tools. It's the layer above them. Your agents still execute in Claude Code. Your actions are still gated by Agent Gate. Command Post governs what gets built and whether it matches the spec.

---

## What's Included

- **Context Monitoring Daemon** — external JSONL transcript parser, zone classification, trend detection
- **Memory Snapshot Protocol** — 4-step replacement flow with quality validation and retry logic
- **PRD Audit Agents** — read-only specification compliance checking with structured findings
- **Governance Hierarchy** — Orchestrator (PO/PM) with authority to spawn agents as needed, human approval gates
- **Inbox Messaging** — file-based inter-agent communication with role-based permissions
- **Tmux Session Management** — every agent runs as a full Claude Code instance with complete tool access, no capability-limited sub-agents

## Roadmap

- [ ] Standalone CLI tool
- [ ] Next.js dashboard with real-time agent status
- [ ] Kanban board for task visualization

---

## Known Limitations

- **Claude Code specific.** The context daemon reads Claude Code's JSONL transcript format. Other agent runtimes would need adapters.
- **File-based messaging.** The inbox system uses JSON files on disk. This is intentional (crash recovery, auditability, simplicity) but won't scale to hundreds of concurrent agents without a message broker.
- **Snapshot quality depends on the agent.** The validation catches structural problems (missing fields, empty next_steps) but can't evaluate whether the *content* of a snapshot is accurate. A well-structured lie passes validation.
- **Not a security boundary.** Command Post governs specification compliance, not adversarial behavior. For action-level security, use Agent Gate or equivalent tooling.
- **Single-machine architecture.** Agents, daemon, and inbox all assume shared filesystem access. Distributed deployment is a future concern.

---

## Related: Agent Gate

[Agent Gate](https://github.com/SeanFDZ/agent-gate) is the execution authority layer for individual AI agents — vault-backed rollback, policy enforcement, and action classification before any destructive operation proceeds.

Command Post governs what agents *build*. Agent Gate governs what agents are *allowed to do*. They address different layers of the same problem:

| Layer | Project | Controls |
|---|---|---|
| **Specification Authority** | Command Post | PRD compliance, audit agents, governance hierarchy |
| **Action Authority** | Agent Gate | Vault-backed rollback, directory enforcement, policy classification |

---

## The Command & Control Analogy

The name isn't metaphorical. It's architectural.

In nuclear command and control, every action requires verified authorization through a chain of command. Permissive Action Links ensure weapons can't be used without proper codes. Looking Glass airborne command posts ensure continuity of authority even when ground stations are destroyed.

Command Post applies the same principles to AI agent teams:

- **Permissive Action Links** → Agent Gate's policy enforcement (no action without authorization)
- **Chain of Command** → Governance hierarchy with human approval gates
- **Looking Glass Continuity** → Memory Snapshot Protocol (authority survives agent replacement)
- **Two-Person Rule** → Audit agents verifying worker output against specifications

The nuclear C2 system doesn't trust any single actor. Neither does Command Post.

---

## Author

**Sean Lavigne** — [GitHub](https://github.com/SeanFDZ) · [LinkedIn](https://www.linkedin.com/in/seanlavigne/)

---

## License

[Apache 2.0](LICENSE)
