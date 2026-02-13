# house-rules.md — cestdone project

## Instructions for all prompts

For the given specifications:
- Make a comprehensive TODO list to keep up with the tasks at hand
- If something is not clear, ask questions to avoid making assumptions
- Each meaningful change should have unit tests. Use TDD (red-green-refactor) for core logic, add tests after for edge cases
- If debugging, use temporary debug logs to confirm diagnosis. Remove them after tests pass
- Use Uncle Bob's Clean Code guidelines. Simple and scalable, no overengineering
- Use the existing logging system (pino) for info, warnings, and errors (not console.log unless debugging)
- Update related documentation. Keep it concise. Don't duplicate across docs
- All files should have the POSIX path as a comment at the top

## Acceptance criteria for every deliverable

1. All tests pass: `npm run test`
2. `npx tsc` has zero errors
3. No unused imports or dead code

## Environment

- Runtime: Node.js + TypeScript
- Test framework: Vitest
- Package manager: npm
- OS: Windows PowerShell — no piping (`| cat`), prefer one-liners
