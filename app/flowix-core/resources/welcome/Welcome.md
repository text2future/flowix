---
status: Complete
flowix_icon: carrot
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

Flowix is a ==document workspace for AI agents==<!-- flowix:text {"bg":null,"fg":"blue"} -->. It helps address common problems when working with AI agents:

- Prompts and instructions are scattered across different places and hard to manage.
- Agents keep making the same mistakes because they lose track of context.
- Workflows that succeed in a conversation are hard to capture and reuse.

Ask AI to capture your workflows, recurring issues, and preferences in Flowix, so you can refer to them in future tasks.

Your everyday notes can become useful source material, too.

---

## 1. Product philosophy

In agent clients, document libraries often sit in the background of projects and conversations. Flowix puts your library at the center and organizes conversations around it.

You can build workflows around your documents, so writing, research, organizing information, and agent tasks all draw on the same source material.

A Flowix notebook can also serve as a project in an agent client, letting you use the same document library across different tools.

---

## 2. Get started

### 2.1 Create and manage notebooks

A notebook is a local folder, and each note is a Markdown file inside it. When you create a notebook, you can use the default Documents folder or choose a custom folder.

- **File Tree and Notes List:** The File Tree gives you access to all documents, including Markdown notes, Word files, and images. The Notes List shows all Markdown notes in the notebook.
- **Default location for new notes:** Choose the folder where notes created from Notes List mode should go.
- **Views:** In File Tree mode, create views for notes or other files and resources to make them easier to browse.
- **Pinning:** In File Tree mode, pin any note, view, or resource file for quick access.

### 2.2 Use AI features

Choose one of these three ways to connect an agent. Before you begin, install, sign in to, and configure the client or model service you plan to use.

1. **Use a local client:** Chat with an agent using a local installation of ChatGPT, Claude Code, or OpenCode. If you use the DeepSeek Harness client, install the Flowix connector plugin from Preferences first.
2. **Use flowix AI with a custom model:** After configuring a model provider, use flowix AI in document mode or code mode. The current integration does not support web search, image generation, or video generation. Available features may vary by version.
3. **Use another agent client:** Open the notebook folder as a project, or connect the document library through the CLI or MCP so your agent can read, search, and update its contents. Configure the connection before using the CLI or MCP.

### 2.3 Set up an AI knowledge base

Tell your agent what you want to accomplish, then ask it to build a folder structure and guidelines around your needs. You can start with this prompt:

```plaintext
My primary goal is: [describe it in one sentence]
Set up an AI document library in the current notebook:
- Design the smallest folder structure that supports this goal.
- Create an AGENTS.md file that explains what each folder is for, how to work in the notebook, and how to maintain it.
- Add or import skills only when needed, and put them in .agents/skills/.
- Keep existing content. Avoid overwriting files or creating duplicates.
- Create only what is necessary, then explain how to get started.
```

### 2.4 Manage notes

- **Tags:** Add tags in the note body, such as #idea, #meeting, #todo, #prompt, or #agent. Flowix detects them automatically.
- **Views:** Browse and manage notes with table, calendar, kanban, and gallery views.
- **Note properties:** Add details such as source, rating, location, or priority. You can create reusable properties in Settings, then fill in values on your notes.

---

## 3. What you can do with Flowix

The folder structures below are examples you can adapt. Flowix does not require a particular layout.

### 3.1 Build a personal AI knowledge base

Keep reading notes, travel plans, work logs, and personal writing in one place. Flowix supports everyday note-taking, organizing reference material, and building a lasting knowledge base.

Add your requirements, source material, and reference links to documents. An agent can use them to summarize, rewrite, answer questions, break work into tasks, or write code. Save the results back to your documents so you can review, edit, and reuse them. Each round of work adds context that you and your agents can use again.

For example, you can organize books, papers, and courses with a Karpathy-style knowledge base:

```
My Notebook/
├── Reference Library/      ← Original materials; keep them unchanged
├── wiki/                   ← Knowledge maintained by an LLM
│   ├── index.md            ← Main index
│   ├── log.md              ← Change log
│   ├── concepts/           ← Concept pages
│   ├── entities/           ← People, organizations, and other entities
│   ├── sources/            ← Source summaries
│   └── synthesis/          ← Syntheses and analysis
├── Generated/              ← Generated output
└── AGENTS.md               ← Knowledge base structure and maintenance rules
```

### 3.2 Create a content workspace for X

Build an ongoing workflow for creating content on X. Use each post’s metrics and replies to guide future topics and drafts, and keep a record of what works.

- The agent can help with ideas, research, drafts, image prompts, publishing checks, and performance reviews.
- You set the direction and visual style, make the key editorial calls, and decide what to publish.

```
X Content Workspace/
├── Profile/
│   ├── Positioning.md          ← Account focus, target audience, and what sets you apart
│   └── Voice and Style.md      ← Tone, phrases to avoid, and how you present yourself
├── Research/
│   ├── Trends/                 ← Emerging topics, search terms, and conversations
│   ├── Benchmarks/             ← Accounts to learn from and high-performing posts
│   └── Audience/               ← Audience profiles, reply insights, and recurring questions
├── Content Ideas/
│   ├── Ideas.md                ← Idea backlog and priorities
│   └── Scoring Criteria.md     ← How to evaluate ideas
├── Content/
│   ├── Drafts/                 ← AI-assisted drafts
│   ├── Final Copy/             ← Approved posts ready to publish
│   ├── Published/              ← Published posts and final versions
│   ├── Media/                  ← Images, video, and scripts
│   └── Calendar.md             ← Content calendar
├── Analytics/
│   ├── Posts/                  ← Metrics for individual posts
│   ├── Weekly Review.md        ← Weekly performance review
│   └── What Works.md           ← Patterns worth reusing
└── AGENTS.md                   ← Agent roles, guidelines, and workflows
```

### 3.3 Develop products with Spec-Driven Development (SDD / Vibe Coding)

With Spec-Driven Development (SDD), you first define what to build, why it matters, and the acceptance criteria. An agent then produces the technical plan, task list, code, and tests. You review the specifications, plan, and code changes at key points.

```plaintext
My Product/
├── .specify/
│   ├── constitution.md         ← Tech stack, conventions, and security principles
│   └── templates/              ← Templates for specs, plans, and tasks
├── specs/
│   └── 001-user-auth/
│       ├── spec.md             ← Requirements and acceptance criteria
│       ├── clarifications.md   ← Clarification notes
│       ├── plan.md             ← Architecture and technical plan
│       ├── data-model.md       ← Entities, fields, and migrations
│       ├── contracts/          ← API, event, and interface contracts
│       ├── research.md         ← Technical research and alternatives
│       ├── checklist.md        ← Pre-release checklist
│       └── tasks.md            ← Actionable task list
├── tests/
└── AGENTS.md                   ← Agent roles, boundaries, and working rules
```

Use **Repositories** in the sidebar to manage multiple code repositories while you work on a product.

---

## 4. Agent instructions and skills

Depending on the agent and workflow you use, your document library may include files and folders such as:

- `AGENTS.md`: Gives agents that support this convention the project background, folder structure, working practices, and maintenance rules.
- `.agents/skills/`: Holds reusable agent skills. Whether a client loads them automatically depends on that client's features and configuration.

These files and folders define how an agent works and what context it can use. Learn what they do before changing them. Deleting them or changing their structure may affect agents and workflows that rely on them. Update the rules as your needs change.

---

## 5. More resources

- Website: [https://flowix.cc/](https://flowix.cc/)
- Documentation: [https://flowix.cc/docs/](https://flowix.cc/docs/)
- GitHub: [https://github.com/text2future/flowix](https://github.com/text2future/flowix)

---

#flowix #gettingstarted #agent #setup
