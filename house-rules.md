# House rules for every scheduled run

cestdone sends this file as the system prompt of every Worker it starts, and as the house rules of every Director plan, for each schedule, webhook and poller in `.cestdonerc.json` (root key `houseRules`). The target repository's `AGENTS.md` and the run's specification add to it. Every run reads this file at start and fails if it is missing, so do not move or rename it. Keep it short, because every run pays for each line.

- Before writing anything a person will read, in any language (a report, an email, a notification, a draft, a reply, a post, a document or a specification), read `C:\Users\dpire\Code\natural-professional-writing-guide-en-es.md` and run its section 20 final editing pass on the text before you save or send it. This applies whether or not the specification names the guide.
- If the guide cannot be read, write the text anyway and record the failed read in the run's report.
