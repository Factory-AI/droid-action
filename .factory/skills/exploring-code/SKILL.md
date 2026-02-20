---
name: exploring-code
description: Systematic code tracing and exploration. Use when reviewing code changes to understand impact radius, trace call graphs, follow exports to usages, and map dependencies.
user-invocable: false
---

# Exploring Code

## Process

1. **Seed**: Grep/search to identify relevant modules, exported functions, types, and constants.
2. **Trace usages**: For each relevant export, find all import and usage locations. Filter for relevance.
3. **Follow the graph**: From each usage, repeat -- follow exports, find their usages, and continue.
4. **Stop when**:
   a. You reach an entrypoint (route handler, CLI command, client-facing feature)
   b. The code path ends with no callers -- flag as **DEAD code**
   c. Further exploration is clearly irrelevant to the task

## Principles

- Never assume code is correct. Always ask: who are the clients of this export?
- Trace both **inward** (what does changed code depend on?) and **outward** (what depends on it?).
- For modified signatures or return types: grep for ALL callers and verify compatibility.
- For new interfaces or type changes: verify all implementations satisfy the contract.
- Follow call chains at least 2 levels deep from changed code.
- Use BFS for breadth, DFS for depth -- combine as needed.
