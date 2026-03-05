# Review Guidelines for droid-action

These are the repository-specific review guidelines. Reviewers MUST follow all rules below when evaluating pull requests.

## Naming Conventions

- All boolean variables must be prefixed with `is`, `has`, `should`, or `can` (e.g., `isValid`, `hasPermission`). Flag any boolean that uses other prefixes or no prefix.
- Avoid single-letter variable names everywhere, including loop iterators. Use descriptive names like `index` or `item` instead of `i` or `x`.
- Constants must use SCREAMING_SNAKE_CASE. If a value is hardcoded and never reassigned, it should be extracted into a named constant.

## Error Handling

- Never swallow errors silently. Every `catch` block must either re-throw, log with `console.error`, or return a meaningful error value. Empty catch blocks are always a bug.
- All async functions that interact with external systems (network, file system, GitHub API) must have explicit error handling -- do not rely on callers to catch.
- When logging errors, always include the original error object or message for debuggability. Logging a generic string like `"something went wrong"` without context is a bug.

## TypeScript-Specific Rules

- Prefer `interface` over `type` for object shapes that could be extended. Use `type` only for unions, intersections, or mapped types.
- Never use `any`. If a type is truly unknown, use `unknown` and narrow appropriately. The only exception is test files where mocking requires it.
- All exported functions must have explicit return type annotations. Inferred return types are acceptable only for private/internal functions.
- Prefer `readonly` arrays and properties when mutation is not needed.

## Code Structure

- Functions must not exceed 50 lines (excluding comments and blank lines). If a function is longer, it should be decomposed.
- No more than 3 levels of nesting (if/for/while). Prefer early returns to reduce nesting depth.
- Avoid `else` after `return` -- use early return pattern instead:
  ```typescript
  // Bad
  if (condition) {
    return x;
  } else {
    return y;
  }

  // Good
  if (condition) {
    return x;
  }
  return y;
  ```

## Comments

- Every comment must start with a capital letter and end without a period. Comments ending with periods are too formal for code.
- TODO comments must include an author tag: `// TODO(username): description`
- Do not comment obvious code. A comment like `// increment counter` above `counter++` is noise and should be flagged.

## Imports

- Imports must be organized in three groups separated by blank lines: (1) external/node modules, (2) internal project imports, (3) relative imports from the same module.
- Prefer named imports over default imports. Default imports make refactoring harder.
- Never import from a barrel file (index.ts) when you can import directly from the source module.

## Security

- Never log sensitive data: tokens, keys, passwords, or full request/response bodies that might contain PII.
- All string interpolation into shell commands must use proper escaping or parameterized execution. Template literal concatenation into `execSync` is always a bug.
- Environment variable access must have fallback handling. Bare `process.env.X!` non-null assertions are not acceptable -- always provide a default or throw a descriptive error.
