import type { PreparedContext, FixContext } from "../types";

export function generateFixPrompt(context: PreparedContext): string {
  const prNumber = context.eventData.isPR
    ? context.eventData.prNumber
    : "unknown";

  const repoFullName = context.repository;
  const commentBody =
    "commentBody" in context.eventData ? context.eventData.commentBody : "";

  const userInstructions = extractUserInstructions(commentBody);

  if (context.eventData.eventName === "pull_request_review_comment") {
    return generateThreadFixPrompt({
      prNumber,
      repoFullName,
      commentBody,
      userInstructions,
      reviewCommentContext: context.fixContext,
    });
  }

  return generateTopLevelFixPrompt({
    prNumber,
    repoFullName,
    commentBody,
    userInstructions,
  });
}

function extractUserInstructions(commentBody: string): string {
  const cleaned = commentBody.replace(/@droid\s+fix/i, "").trim();
  return cleaned || "";
}

type ThreadFixPromptOptions = {
  prNumber: string;
  repoFullName: string;
  commentBody: string;
  userInstructions: string;
  reviewCommentContext?: FixContext;
};

function generateThreadFixPrompt({
  prNumber,
  repoFullName,
  userInstructions,
  reviewCommentContext,
}: ThreadFixPromptOptions): string {
  const filePath = reviewCommentContext?.filePath ?? "unknown";
  const line = reviewCommentContext?.line;
  const parentBody = reviewCommentContext?.parentCommentBody ?? "";

  const lineContext = line ? ` around line ${line}` : "";

  return `You are fixing a specific code review issue on PR #${prNumber} in ${repoFullName}.
The gh CLI is installed and authenticated via GH_TOKEN.

## Review Issue to Fix

The following review comment identified an issue in \`${filePath}\`${lineContext}:

\`\`\`
${parentBody}
\`\`\`
${userInstructions ? `\n## Additional Instructions from User\n\n${userInstructions}\n` : ""}
## Procedure

1. **Understand the issue**: Read the review comment above carefully. Read the file at the specified path to understand the surrounding code context.
2. **Check the PR diff** for additional context:
   - Run: \`gh pr diff ${prNumber} --repo ${repoFullName}\`
3. **Implement the fix**: Edit the file(s) to resolve the issue identified in the review comment.
4. **Verify the fix**:
   - Read the modified file(s) to confirm correctness.
   - If the project has tests, try running them: look for test scripts in package.json, Makefile, or similar config files.
5. **Commit and push**:
   - Run: \`git add -A\`
   - Run: \`git commit -m "fix: address review comment in ${filePath}"\`
   - Run: \`git push\`

## Rules

- Only fix the specific issue mentioned in the review comment. Do not make unrelated changes.
- Keep changes minimal and focused.
- Follow the existing code style and conventions in the repository.
- If you cannot determine the correct fix with confidence, explain what you found and suggest a fix in a comment instead of making a wrong change.
- Never introduce new lint errors or break existing tests.
- Update the tracking comment with progress using the github_comment___update_droid_comment tool.
`;
}

type TopLevelFixPromptOptions = {
  prNumber: string;
  repoFullName: string;
  commentBody: string;
  userInstructions: string;
};

function generateTopLevelFixPrompt({
  prNumber,
  repoFullName,
  userInstructions,
}: TopLevelFixPromptOptions): string {
  return `You are fixing code issues on PR #${prNumber} in ${repoFullName}.
The gh CLI is installed and authenticated via GH_TOKEN.

## Procedure

1. **Gather context**:
   - Run: \`gh pr view ${prNumber} --repo ${repoFullName} --json title,body\`
   - Run: \`gh pr view ${prNumber} --repo ${repoFullName} --json comments,reviews\`
   - Run: \`gh pr diff ${prNumber} --repo ${repoFullName}\`
   - Run: \`gh api repos/${repoFullName}/pulls/${prNumber}/reviews --paginate --jq '.[] | {user: .user.login, state: .state, body: .body}'\`
   - Run: \`gh api repos/${repoFullName}/pulls/${prNumber}/comments --paginate --jq '.[] | {path: .path, line: .line, body: .body, user: .user.login}'\`

2. **Identify issues to fix**:
   - Review all review comments and feedback on the PR.
   - ${userInstructions ? `The user specifically asked: "${userInstructions}". Prioritize these instructions.` : "Identify all actionable review findings that require code changes."}
   - Categorize issues by file and severity.

3. **Implement fixes**:
   - Address each identified issue systematically, file by file.
   - Read each file before editing to understand the full context.
   - Make minimal, focused changes that directly address the review feedback.

4. **Verify fixes**:
   - Read modified files to confirm correctness.
   - If the project has tests, try running them: look for test scripts in package.json, Makefile, or similar config files.
   - Check for lint/format scripts and run them if available.

5. **Commit and push**:
   - Run: \`git add -A\`
   - Run: \`git commit -m "fix: address review feedback on PR #${prNumber}"\`
   - Run: \`git push\`

## Rules

- Follow the existing code style and conventions in the repository.
- Keep changes focused on addressing review feedback. Do not refactor unrelated code.
- If a review comment is unclear or you cannot determine the correct fix, skip it and note it in the tracking comment.
- Never introduce new lint errors or break existing tests.
- Update the tracking comment with progress using the github_comment___update_droid_comment tool.
`;
}
