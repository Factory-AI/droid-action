---
name: software-design-principles
description: Software design principles and red flags for code review. Use during design-level review passes to identify structural problems like complexity, information leakage, and poor abstractions. Provides concrete examples of each anti-pattern.
user-invocable: false
---

# Software Design Principles

Design principles and red flags to evaluate during code review. Use these to identify structural problems that predict future bugs and maintenance burden, not just current correctness.

## Core Principle

**Complexity is the enemy.** Minimize it through good design, not just working code.

## Recognizing Complexity

### Three Symptoms

1. **Change Amplification** -- A simple change requires modifications in many places
2. **Cognitive Load** -- Too much information needed to complete a task
3. **Unknown Unknowns** -- Not clear what code needs to change or what information is required (the worst symptom)

### Two Root Causes

1. **Dependencies** -- Code can't be understood or modified in isolation
2. **Obscurity** -- Important information is not obvious (bad names, poor docs, inconsistency)

## Design Guidelines

### Deep Modules

- Interfaces should be **simpler than implementations**
- Ask: "What complexity does this module hide from its callers?"
- Avoid many small classes/functions that do little individually

### Information Hiding

- Embed design decisions within module implementations
- Expose only what callers **need** to know
- Consolidate knowledge that appears in multiple places

### Pull Complexity Downward

- Make life easier for callers, even if implementation is harder
- Avoid pushing configuration options upward
- Handle edge cases inside the module, not at call sites

### Strategic Over Tactical

- Invest in good design, not just "making it work"
- Small improvements compound; small hacks accumulate into debt

### Static Type Safety

- Static types surface hidden dependencies or assumptions by making cases explicit
- Avoid `any` types or type casts/assertions that may violate type safety

## Red Flags (With Concrete Examples)

### Shallow Module

Interface complexity ≈ implementation complexity; little abstraction value.
**Example**: A `LinkedList` class that exposes `next` and `prev` pointers directly, requiring callers to manage list traversal themselves.

### Information Leakage

Same knowledge duplicated across modules, or implementation details exposed in APIs.
**Example**: HTTP parsing logic duplicated in both request handler and response handler because they both need to understand the wire format.

### Temporal Decomposition

Code organized by execution order ("first X, then Y, then Z") rather than by information hiding.
**Example**: Separate classes `ConfigReader`, `ConfigParser`, `ConfigValidator` that each know about the config file format, instead of one `ConfigManager` that hides the format entirely.

### Overexposure

API forces callers to understand rarely-used features.
**Example**: A function with 8 parameters where callers always pass the same values for 6 of them (those should be defaults or internal decisions).

### Pass-Through Method

Method that just delegates to another with the same or similar signature.
**Example**: `UserService.getUser(id)` that just calls `UserRepository.getUser(id)` -- the service layer adds no value.

### Repetition

Similar code in multiple places, indicating a missing abstraction.
**Example**: The same null-check + default-value pattern repeated in 15 different functions instead of extracted into a utility.

### Special-General Mixture

General-purpose mechanism polluted with application-specific code.
**Example**: A generic caching library that has hardcoded knowledge of specific entity types for invalidation logic.

### Conjoined Methods

Methods that can't be understood independently; implicit coupling.
**Example**: `prepare()` and `execute()` where `execute` silently fails if `prepare` wasn't called first, but this isn't enforced by the API.

### Leaky Abstraction

Callers must understand implementation details to use the API correctly.
**Example**: A database wrapper where callers need to know about connection pooling internals to avoid deadlocks, or must handle specific vendor error codes.

### Exception Spreading

Exceptions propagating through many levels, caught/wrapped/logged/rethrown repeatedly.
**Example**: An error caught at layer 1, wrapped and rethrown at layer 2, logged at layer 3, wrapped again at layer 4 -- creating noise and obscuring the root cause.
