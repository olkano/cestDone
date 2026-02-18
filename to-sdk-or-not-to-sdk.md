Here’s the clean separation that makes everything else make sense:

### Claude Code (CLI) vs Claude Agent SDK (library): billing + file access

* **Claude Agent SDK** is an **API product**: it explicitly tells you to “set your API key” (`ANTHROPIC_API_KEY`) and adds that Anthropic does **not** allow third-party developers to offer **claude.ai login / subscription rate limits** for products built on the SDK—use API-key auth instead. ([Claude][1])
* **Claude Code (CLI)** is a **terminal app** that can be authenticated to your **Pro/Max subscription**. It also warns that **if `ANTHROPIC_API_KEY` is set, it will charge API usage instead of using your subscription**. ([Claude Help Center][2])

So the “it uses API consumption by design” statement is **true for the Agent SDK**, but **not** true for Claude Code the CLI.

---

## 1) How does OpenClaw use Claude Code programmatically without the Agent SDK? Does it have file/tool access?

OpenClaw isn’t using the Agent SDK at all. It’s doing the simplest possible thing: **spawning the coding-agent CLI as a subprocess** and driving it like a terminal program.

Concretely, OpenClaw’s own “coding-agent” skill says:

* these agents are **interactive terminal apps** and require a **pseudo-terminal (PTY)**,
* you run them with a `workdir` so the agent’s “world” is that folder (your repo),
* you can run them in the background and stream logs / write to stdin. ([GitHub][3])

Because it’s literally running `claude` (or `codex`) **inside your repo directory**, **file access and tool access are whatever that CLI already has** (read/edit files, run commands, plus MCP servers if configured). OpenClaw is just orchestration glue.

Also: Claude Code itself supports “headless / print” scripting modes (`claude -p …`) and structured output (`--output-format json|stream-json`) explicitly for automation. ([Claude Code][4])

**Net:** OpenClaw gets file + tool access because **Claude Code is the thing that has file + tool access**; OpenClaw just launches it correctly (PTY + workdir) and parses/relays the I/O. ([GitHub][3])

---

## 2) Is there an Agent SDK equivalent with Codex/OpenAI, and is it cheaper?

Yes—there are *two* “equivalents,” depending on what you mean by “Agent SDK”:

### A) OpenAI Agents SDK (API-based, like Anthropic’s Agent SDK)

OpenAI has an **Agents SDK** for building agentic apps (multi-agent handoffs, tool use, streaming, traces). It’s part of the OpenAI developer platform and is **API-billed**. ([OpenAI Developers][5])

**Pricing (API):**

* OpenAI API “standard” rates list **gpt-5.1** at **$1.25 / MTok input** and **$10 / MTok output** (and there are lower “Flex” rates if you can tolerate latency). ([OpenAI Developers][6])
* Anthropic lists **Sonnet 4.5** at **$3 / MTok input** and **$15 / MTok output** (≤200K context). ([Claude][7])

So on pure token rates, OpenAI can be **materially cheaper** than Anthropic for a lot of workloads, especially on input. ([OpenAI Developers][6])

### B) Codex CLI / Codex SDK (local coding agent with repo access, can be subscription-based)

If your real requirement is: **“an agent that can read/edit/run code in my repo”** (the thing you used Agent SDK for), then OpenAI’s closest match to “Claude Code CLI” is **Codex CLI**:

* It “can read, change, and run code on your machine in the selected directory,” and it’s included with ChatGPT paid plans. ([OpenAI Developers][8])
* Codex supports **two sign-in modes**: **ChatGPT subscription access** or **API key usage-based access**. ([OpenAI Developers][9])
* The Codex pricing page also states Codex is included with ChatGPT plans and you can extend usage with credits; API-key mode is separate. ([OpenAI Developers][10])

So if your pain point is **Anthropic API pricing**, the *big move* is often: **stop using an API-only SDK for local-repo work**, and instead orchestrate a **CLI agent** that can authenticate via a **consumer subscription** (Claude Code Pro/Max, or Codex via ChatGPT plans). ([Claude Help Center][2])

---

### Practical takeaways for your specific situation

* If you want to keep using **Claude** *and* keep costs inside **Max**: don’t use **Agent SDK**. Use **Claude Code CLI** in headless mode (`claude -p … --output-format json`) and make sure `ANTHROPIC_API_KEY` is **not** set so it doesn’t silently switch you to API billing. ([Claude Help Center][2])
* If you want a similar workflow in the **OpenAI** ecosystem: use **Codex CLI** signed in with **ChatGPT** (subscription mode) for local-repo work; use **OpenAI Agents SDK** only when you explicitly want an API agent you’re comfortable paying per token for. ([OpenAI Developers][8])

If you tell me what you’re currently running (OS + whether you’re launching Claude Code via Node/Python + whether you need streaming + whether you need tool approvals), I can sketch the simplest “spawn CLI agent + JSON output + repo sandbox” architecture for your exact setup.

[1]: https://platform.claude.com/docs/en/agent-sdk/overview "Agent SDK overview - Claude API Docs"
[2]: https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan "Using Claude Code with your Pro or Max plan | Claude Help Center"
[3]: https://raw.githubusercontent.com/openclaw/openclaw/main/skills/coding-agent/SKILL.md "raw.githubusercontent.com"
[4]: https://code.claude.com/docs/en/headless "Run Claude Code programmatically - Claude Code Docs"
[5]: https://developers.openai.com/api/docs/guides/agents-sdk/?utm_source=chatgpt.com "Agents SDK | OpenAI API"
[6]: https://developers.openai.com/api/docs/pricing/ "Pricing | OpenAI API"
[7]: https://claude.com/pricing "Plans & Pricing | Claude by Anthropic"
[8]: https://developers.openai.com/codex/cli/ "Codex CLI"
[9]: https://developers.openai.com/codex/auth "Authentication"
[10]: https://developers.openai.com/codex/pricing "Codex Pricing"
