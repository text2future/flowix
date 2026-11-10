---
status: Complete
flowix_icon: sandwich
flowix_property_types:
  keywords: MultiSelect
keywords:
  - overview
  - what-is
  - value-prop
  - quickstart
  - setup
  - ai-agent
---


# ++flowix keeps the document base behind your Agent visible, editable, and fixable++

An AI Agent's performance usually comes down to a document base you never see.

It may have read a stale source, skipped a rule that mattered, or kept repeating the same mistake for lack of context. You see the answers — not the reasoning behind them.

flowix brings that hidden context into view. Built around a document base, it lets you browse the sources and rules your Agent relies on, review what it produces, and go back into the documents to fix what went wrong.

Working with an Agent stops being an endless loop of prompt tweaking, and becomes an ongoing effort to improve what it works from.

---

## 1. The idea behind flowix

With most Agent clients, the document base sits out of sight behind the chat. You rarely know what the Agent read, which rules it followed, or what context it missed — and when the output is wrong, it's hard to tell where the fault lies.

flowix puts that hidden context in plain sight. Centered on a document base, it lets you browse the notes, rules, and outputs your Agent depends on, the same way you'd organize project materials — and when something's off, edit the sources and adjust the rules directly, so the next task goes better.

flowix isn't just about letting AI read your documents. It's about letting you understand and steer what AI works from.

> ### What it fixes
>
> - **You can't see what the Agent works from**: no visibility into which sources it read or which rules it follows.
> - **Context is scattered**: sources, prompts, rules, and workflows live in different places — hard to organize, harder to keep current.
> - **Failures are hard to trace**: when the output misses the mark, you can't pinpoint why, let alone fix how the Agent works.
>
> flowix takes you from trial and error to steadily improving what the Agent works from.

---

## 2. Getting started

### 2.1 Creating and managing notebooks

A notebook is just a local folder, and notes are the Markdown files inside it. When you create one, take the default Documents location or pick your own.

- **File tree and note list**: the file tree (Access Space) manages every document — Markdown notes, Word files, images, and more. The note list covers only the Markdown notes in the current notebook.
- **Where new notes land**: set the folder used when creating notes in note list mode.
- **Views**: in file tree mode, build views over notes and other materials to browse and search them from different angles.
- **Pinning**: pin any note, view, or material file to keep it within reach.

### 2.2 Using AI features

Take whichever of these three routes suits you. Either way, install, sign in to, and configure the client or model service first.

- **Local clients**: chat through clients you already have installed — ChatGPT, Claude Code, OpenCode, and others. Using DeepSeek Harness? Install the flowix connector plugin in Preferences first.
- **flowix AI with your own model**: once a model service is configured, work in document mode or code mode. Web search and image or video generation aren't supported yet; exactly what you get depends on your version.
- **Third-party Agent clients**: open the notebook folder as a project, or hook the document base up over CLI / MCP, so the Agent can read, search, and update your content. Set up the connection first.

### 2.3 Setting up an AI knowledge base

Tell the Agent what you're after, and let it shape the folder structure and ground rules around your actual needs. This prompt is a good starting point:

```plaintext
What I need: [one sentence on the goal]

Please set up an AI document base in this notebook:
- Design the smallest folder structure that meets the goal.
- Write AGENTS.md covering what each folder is for, how work gets done, and how to maintain it.
- Only create or import skills when there's a real need, and keep them in .agents/skills/.
- Leave existing content intact — don't overwrite or duplicate anything.
- Build only what's necessary, then tell me how to start using it.
```

### 2.4 Managing notes

- **Tags**: mark up documents in the body with tags like #idea, #meeting, #todo, #prompt, #agent.
- **Views**: browse and manage notes as tables, calendars, boards, or galleries.
- **Note properties**: attach properties such as source, rating, location, and priority. Create the preset properties in Settings first, then fill in values for individual notes.

---

## 3. Use cases

The folder layouts below are examples you can reshape to fit — flowix doesn't require any of them.

### ==3.1 A personal AI knowledge base==<!-- flowix:text {"bg":"purple","fg":"purple"} -->

Turn books, papers, courses, and day-to-day notes into a structured document base, so the Agent can cite sources you can actually trace whenever it answers, writes, or researches.

Check the sources whenever you like, correct conclusions, and write the Agent's output back into the documents. The knowledge base grows with use, becoming a work basis you can audit, edit, and reuse.

```plaintext
my-notebook/
├── sources/          ← raw material, read-only
├── wiki/             ← knowledge layer maintained by the LLM
│   ├── index.md      ← master index
│   ├── log.md        ← change log
│   ├── concepts/     ← concept pages
│   ├── entities/     ← entity pages
│   ├── sources/      ← source summaries
│   └── synthesis/    ← cross-source analysis
├── output/           ← generated deliverables
└── AGENTS.md         ← knowledge base structure and maintenance rules
```

### ==3.2 A document workbench for Xiaohongshu==<!-- flowix:text {"bg":"purple","fg":"purple"} -->

Keep positioning, audience insight, topic rules, content assets, and performance reviews in one place, so the Agent can ideate, write, and review from the same context.

The Agent picks topics, gathers research, drafts, writes cover prompts, runs pre-publish checks, and reviews the numbers. You own positioning, taste, the judgment calls, and the final publish. Every post's metrics and comments become input for the next round of ideas.

```plaintext
xiaohongshu-workbench/
├── account/
│   ├── positioning.md    ← positioning, target audience, differentiation
│   └── brand-voice.md    ← tone, banned phrasing, persona boundaries
├── market/
│   ├── trends/           ← hot topics, search terms, platform hashtags
│   ├── benchmarks/       ← comparable accounts and viral post teardowns
│   └── personas/         ← personas, comment insights, recurring questions
├── topics/
│   ├── backlog.md        ← topic ideas and priorities
│   └── scoring.md        ← how topics are scored
├── content/
│   ├── drafts/           ← AI first drafts
│   ├── final/            ← human-finalized versions
│   ├── published/        ← live posts and their final versions
│   ├── assets/           ← covers, images, video scripts
│   └── calendar.md       ← content calendar
├── reviews/
│   ├── posts/            ← per-post metrics
│   ├── weekly.md         ← weekly review
│   └── what-works.md     ← reusable patterns behind hits
└── AGENTS.md             ← Agent roles, rules, and workflows
```

### ==3.3 Product development: spec-driven development (SDD / vibe coding)==<!-- flowix:text {"bg":"purple","fg":"purple"} -->

Capture requirements, acceptance criteria, technical design, interface contracts, and task lists as structured documents, so the Agent can produce plans and code by the rules.

You review the gaps between spec and build at key checkpoints — less rework, fewer surprises, and a development process you can trace and reuse.

```plaintext
my-product/
├── .specify/
│   ├── constitution.md       ← stack, conventions, security principles
│   └── templates/            ← spec, plan, and tasks templates
├── specs/
│   └── 001-user-auth/
│       ├── spec.md           ← requirements and acceptance criteria
│       ├── clarifications.md ← open questions and answers
│       ├── plan.md           ← architecture and technical approach
│       ├── data-model.md     ← entities, fields, migrations
│       ├── contracts/        ← API / event / interface contracts
│       ├── research.md       ← technical research and alternatives
│       ├── checklist.md      ← pre-release checklist
│       └── tasks.md          ← actionable task list
├── tests/
└── AGENTS.md                 ← Agent roles, boundaries, and working rules
```

For product work, manage multiple code repositories from Repositories in the sidebar.

---

## 4. Conventional files and folders

Depending on the Agent and workflow conventions you use, a document base may include:

- **AGENTS.md**: tells Agents that follow this convention about project background, folder structure, how work gets done, and how to maintain things.
- **.agents/skills/**: reusable Agent skills.

These files and folders hold the Agent's operating rules, capability definitions, and project context. Keep the rules in them current as your needs change.

## 5. References

- Website: [https://flowix.cc/](https://flowix.cc/)
- GitHub: [https://github.com/text2future/flowix](https://github.com/text2future/flowix)

#flowix #gettingstarted #agent #setup

&nbsp;
