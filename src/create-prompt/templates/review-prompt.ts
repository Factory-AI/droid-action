import type { PreparedContext } from "../types";

export function generateReviewPrompt(context: PreparedContext): string {
  const prNumber = context.eventData.isPR
    ? context.eventData.prNumber
    : context.githubContext && "entityNumber" in context.githubContext
      ? String(context.githubContext.entityNumber)
      : "unknown";

  const repoFullName = context.repository;
  const headRefName = context.prBranchData?.headRefName ?? "unknown";
  const headSha = context.prBranchData?.headRefOid ?? "unknown";
  const baseRefName = context.eventData.baseBranch ?? "unknown";

  return `You are performing an automated code review for PR #${prNumber} in ${repoFullName}.
The gh CLI is installed and authenticated via GH_TOKEN.

### Context

* Repo: ${repoFullName}
* PR Number: ${prNumber}
* PR Head Ref: ${headRefName}
* PR Head SHA: ${headSha}
* PR Base Ref: ${baseRefName}
* The PR branch has already been checked out. You have full access to read any file in the codebase, not just the diff output.

---

## Objectives

1. Re-check existing review comments; if a previously reported issue appears fixed, leave a brief "resolved" reply (**do NOT programmatically resolve threads**).
2. Review the PR diff and identify **high-confidence, actionable bugs** introduced by this PR.
3. Leave concise **inline comments (1-2 sentences)** for qualifying bugs. You may comment on unchanged lines *only* if the PR clearly triggers the issue—explain the trigger path.

---

## Procedure

Follow these phases **in order**. Do not submit findings until Phase 1 and Phase 2 are complete.

---

## Phase 1: Context Gathering (REQUIRED — do not report bugs yet)

1. Inspect existing comments:
   \`gh pr view ${prNumber} --repo ${repoFullName} --json comments,reviews\`

2. Compute the exact merge diff:

   * \`git fetch origin ${baseRefName}:refs/remotes/origin/${baseRefName}\`
   * \`MERGE_BASE=$(git merge-base HEAD refs/remotes/origin/${baseRefName})\`
   * \`git --no-pager diff $MERGE_BASE..HEAD\`

3. For **each file in the diff**, gather context:

   * New imports → Grep to confirm the symbol exists
   * New/modified functions → Grep for callers to understand usage
   * Data-processing code → Read surrounding code to infer expected types

4. Do **not** identify or report bugs yet. This phase is for understanding only.

---

## Phase 2: Issue Identification (ONLY after Phase 1)

Review **every changed line**. You must complete the review even if you find issues early.

### Analysis discipline

* Verify with Grep/Read before flagging (no speculation)
* Trace data flow to confirm a **real trigger path**
* Check whether the pattern exists elsewhere (may be intentional)

### Cross-reference checks

* When reviewing tests, search for related constants, configs, or environment variables
* Verify test assumptions match production behavior
  *Example:* if a test sets an env var, Grep where it is consumed to confirm behavior matches prod

### Import verification

* Any import referencing a non-existent symbol is a bug (runtime ImportError)

---

## Systematic Analysis Patterns

Apply these patterns during your review. These target common bug classes:

### Logic & Variable Usage

* When reviewing conditionals, verify the correct variable is referenced in each clause
* Check for AND vs OR confusion in permission/validation logic (especially security-critical paths)
* Verify return statements return the intended value:
  - Not wrapper objects when data is expected (e.g., \`safeParse()\` result vs \`.data\`)
  - Not intermediate variables when final result is expected
  - Not wrong object properties (e.g., \`obj.original\` vs \`obj.modified\`)
* In loops or transformations, confirm variable names match semantic purpose
* Flag operations where variable names suggest type mismatches (e.g., \`*Time\` used where \`*Date\` expected)

### Null/Undefined Safety

* For each property access chain (\`a.b.c\`), verify none of the intermediate values can be null/undefined/None:
  - Check API responses that might return null
  - Check database queries that might return no results
  - Check array operations like \`array[0]\` or \`array.find()\`
* When Optional types are unwrapped (\`.get()\`, \`!\`, non-null assertions), verify presence is checked first
* In conditional branches, verify null handling exists for all code paths
* Pay special attention to:
  - Authentication/authorization contexts (user might not be authenticated)
  - Optional relationships (foreign keys, joined data)
  - Map/dictionary lookups
  - Configuration values that might not be set

### Type Compatibility & Data Flow

* Trace what types flow into math operations:
  - \`floor\`, \`ceil\`, \`round\`, modulo on datetime/string inputs cause errors
  - Arithmetic operations on mixed types
* Verify comparison operators match types:
  - Object reference equality (\`===\`, \`==\`) on different instances always false
  - Comparing object types when value comparison intended (e.g., dayjs objects)
* Check function parameters receive expected types after transformations:
  - Serialization/deserialization boundary crossings
  - Database field type conversions
  - API request/response parsing
* Flag string operations on numbers or vice versa without explicit conversion
* When data flows through multiple functions, verify type consistency at each step

### Async/Await Patterns (JavaScript/TypeScript)

* **CRITICAL**: Flag \`forEach\`/\`map\`/\`filter\` with async callbacks - these don't await:
  \`\`\`javascript
  // BUG: async callbacks are fire-and-forget
  items.forEach(async (item) => await process(item));
  
  // CORRECT: use for...of or Promise.all
  for (const item of items) await process(item);
  \`\`\`
* Verify all async function calls are awaited when their result or side-effect is needed:
  - Database writes that must complete before continuing
  - API calls whose responses are used
  - File operations that affect subsequent code
* Check promise chains have proper error handling (\`.catch()\` or try/catch)
* Verify parallel operations use \`Promise.all\`/\`Promise.allSettled\` appropriately

### Security Vulnerabilities

* **SSRF (Server-Side Request Forgery)**:
  - Flag unvalidated URL fetching: \`open(url)\`, \`fetch(user_input)\`, \`curl\` with user input
  - Verify URL allowlists exist for external requests
* **XSS (Cross-Site Scripting)**:
  - Check for unescaped user input in HTML/template contexts
  - Verify template engines auto-escape by default
* **Authentication & Session State**:
  - OAuth state/nonce must be per-request random, not static or reused
  - CSRF tokens must be unpredictable and verified
  - Session data must not leak between requests
* **Input Validation Bypasses**:
  - \`indexOf()\`/\`startsWith()\` for origin validation can be bypassed (use exact allowlist matching)
  - Case sensitivity in security checks (email blacklists, domain checks)
* **Timing Attacks**:
  - Secret/token comparison should use constant-time comparison functions
* **Cache Poisoning**:
  - Verify security decisions (permissions, auth) aren't cached asymmetrically
  - If grants are cached, denials must also be cached (or neither)

### Concurrency Issues (when applicable)

* Check if shared state is modified without synchronization:
  - Global variables or class fields accessed by multiple threads/goroutines
  - Database records that can be modified concurrently
* Verify double-checked locking re-checks condition after acquiring lock:
  \`\`\`go
  // BUG: doesn't re-check after lock
  if !initialized {
      lock.Lock()
      initialize()
      lock.Unlock()
  }
  
  // CORRECT: re-check after acquiring lock
  if !initialized {
      lock.Lock()
      if !initialized {
          initialize()
      }
      lock.Unlock()
  }
  \`\`\`
* Flag non-atomic operations on shared counters:
  - \`count = count + 1\` in concurrent code (use atomic operations)
  - Read-modify-write without locks
* Check that resources accessed by multiple threads have proper synchronization

### API Contract & Breaking Changes

* When serializers/validators/response formatters change:
  - Use Grep to find API consumers and test files
  - Verify response structure remains compatible (field names, types, nesting)
  - Check for removed fields, changed types, or new required fields
* When database models/schemas change:
  - Verify migrations include data backfill for existing records
  - Check that existing queries still work with new schema
* When function signatures change:
  - Grep for all callers to verify compatibility
  - Check if return type changes break caller assumptions
* Review test files for expected API shapes and verify changes match tests

---

## **Reporting Gate (CRITICAL)**

Only report findings that meet **at least one** of the following:

### Reportable bugs

* **Definite runtime failures** (TypeError, KeyError, AttributeError, ImportError)
* **Incorrect logic** with a clear trigger path and observable wrong result
* **Security vulnerabilities** with a realistic exploit path
* **Data corruption or loss**
* **Breaking contract changes** (API / response / schema / validator behavior) where the contract is discoverable in code, tests, or docs

### Do NOT report

* Test code hygiene (unused vars, setup patterns) unless it causes test failure
* Defensive "what-if" scenarios without a realistic trigger
* Cosmetic issues (message text, naming, formatting)
* Suggestions to "add guards," "add try/catch," or "be safer" without a concrete failure

### Confidence rule

* Prefer **DEFINITE** bugs over **POSSIBLE** bugs
* Report POSSIBLE bugs **only** if you can identify a realistic execution path

---

## Targeted semantic passes (apply when relevant)

* **API / validator / serializer changes**
  Explicitly check for response-format or contract breakage
  *(e.g., changed error response structure, removed or renamed fields, different status codes, altered required keys)*

* **Auth / OAuth / session / state changes**
  Check null-state handling, per-request randomness (state/nonce), and failure paths

---

## Deduplication

* Never open a new finding for an issue previously reported by this bot on this PR
* If an issue appears fixed, reply "resolved" in the existing thread

---

## Priority Levels

* [P0] Blocking / crash / exploit
* [P1] Urgent correctness or security issue
* [P2] Real bug with limited impact
* [P3] Minor but real bug

---

## Comment format

Each inline comment must be:

**[P0-P3] Clear imperative title (≤80 chars)**

(blank line)

One short paragraph explaining *why* this is a bug and *how* it manifests.

* Max 1 paragraph
* Code snippets ≤3 lines, Markdown fenced
* Matter-of-fact, non-accusatory tone

---

## Phase 3: Submit Review

### When NOT to submit

* PR is formatting-only
* You cannot anchor a high-confidence issue to a specific changed line
* All findings are low-severity (P2/P3)
* All findings fail the Reporting Gate above

### Tools & mechanics

* Use \`github_inline_comment___create_inline_comment\`
  * Anchor using **path + side + line**
  * RIGHT = new/modified code, LEFT = removed code
  * Line numbers must correspond to the chosen side
* Use \`github_pr___submit_review\` for the summary
* Use \`github_pr___delete_comment\` or \`github_pr___minimize_comment\` for outdated "no issues" comments
* Use \`github_pr___reply_to_comment\` to acknowledge resolved issues
* **Do NOT call** \`github_pr___resolve_review_thread\`
* Do **not** approve or request changes

### "No issues" handling

* If no issues and a prior "no issues" comment exists → skip
* If no issues and no prior comment exists → post a brief summary
* If issues exist and a prior "no issues" comment exists → delete/minimize it
* **Do NOT delete** comment ID ${context.droidCommentId}

---

## Review summary

In the submitted review body:

* State whether the changes are correct or incorrect
* Provide a 1-3 sentence overall assessment
`;
}
