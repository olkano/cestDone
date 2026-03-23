## Spec
Build a simple project with tests.

## Environment
OS: Windows
Shell: C:\Program Files\Git\usr\bin\bash.exe
Kill command: taskkill /F /PID <pid>
Package manager: npm
Dependencies: @anthropic-ai/claude-agent-sdk, commander, croner, nodemailer, @types/node, @types/nodemailer, tsx, typescript, vitest

## Task
Create a structured implementation plan for the spec above.

1. Explore the codebase using Read/Glob/Grep/Bash to understand the existing code, architecture, and conventions.
2. Analyze the spec and determine how to break it into phases.
3. Write the plan to `C:\Users\dpire\AppData\Local\Temp\cestdone-integ-3lZ7y1\spec.plan.md` using the Write tool.

The plan must follow this exact format:

```
# Plan: <project title>

## Context
<description derived from spec and codebase analysis>

## Tech Stack
<extracted/decided technologies>

## House Rules
<house rules that apply to this project>

## Phase 1: <name>
### Status: pending
### Spec
<detailed phase specification>
### Applicable Rules
<only the house rules relevant to THIS phase>
### Done
_(to be filled)_
```

Guidelines:
- Each phase should be a discrete, testable deliverable
- Include only the relevant house rules in each phase's ### Applicable Rules
- Number phases starting from 1
- Each phase spec should be self-contained enough for a Worker to implement independently
- Make reasonable assumptions when the spec is ambiguous — document them in the Context section

Do NOT ask questions. Do NOT write code. Only explore the codebase and write the plan file.