# Autonomous Project OS — Product Functional Specification

*[中文版本 / Chinese version](autonomous-project-os.zh.md)*

An autonomous project operating system for hybrid Human–Agent teams

- Document version: V0.2
- Product stage: concept design / MVP planning
- Target users: enterprise engineering teams, product teams, project-driven organizations, OPCs, one-person companies, and small startup teams

---

## 1. Product Overview

### 1.1 Product Name

Autonomous Project OS

Chinese working name:

自主项目操作系统 (Autonomous Project Operating System)

Short name:

APOS

---

### 1.2 Product Positioning

Autonomous Project OS is an autonomous project management and delivery platform built for hybrid Human–Agent teams.

Once a user files a requirement — through natural language, a form, a document, or an external system — the Project Agent in the system can carry out, on its own:

- understanding and clarifying the requirement;
- project planning;
- work breakdown;
- dependency analysis;
- assignment to people and Agents;
- multi-Agent coordinated execution;
- progress tracking;
- risk and blocker detection;
- verification of deliverables;
- capture of project knowledge.

The system does not let Agents run unbounded. A Policy Engine and Human-in-the-Loop mechanisms bring human judgment in at the moments that matter: requirement goals, solution choices, high-risk operations, production releases, and business acceptance.

In one sentence:

> Let Agents drive the project forward; let humans stay in control of goals, risk, and the boundaries of accountability.

---

## 2. Background

Traditional project management tools solve for:

- recording requirements;
- creating tasks;
- assigning owners;
- displaying progress;
- flagging overdue work;
- tallying completion.

The founding assumption behind that class of product is:

> People are the ones doing the work; the system is a place to record and display it.

As Code Agents, Research Agents, Test Agents, Browser Agents, and Data Agents enter the enterprise, project teams gradually turn into:

```
Human
   +
Project Agent
   +
Code Agent
   +
Test Agent
   +
Review Agent
   +
Research Agent
```

At that point, traditional project management tools run into several problems:

1. Agents cannot be registered as first-class executors inside the project management system;
2. a board records state but cannot push a project forward;
3. Agent tasks, runs, and outputs have nowhere to live under unified management;
4. there is no shared scheduling or dependency management across multiple Agents;
5. humans cannot tell when they are actually needed;
6. Agent permissions, cost, risk, and accountability boundaries go ungoverned;
7. when the project ends, hard-won execution experience never becomes a reusable asset.

The goal of Autonomous Project OS is not to bolt a chatbot onto a traditional board. It is to redesign the project runtime for hybrid Human–Agent teams.

---

## 3. Vision

### 3.1 Vision

Build the in-house Human–Agent project operating system: projects that plan themselves, drive themselves, recover themselves, and keep learning — all inside explicit human governance boundaries.

---

### 3.2 Core Principles

#### Agents drive, humans govern

Agents take the high-frequency, repetitive, verifiable work. Humans take:

- defining goals;
- judging value;
- confirming critical constraints;
- handling high-risk decisions;
- carrying final accountability;
- accepting business outcomes;
- writing and refining the rules.

#### Flow first, not task count first

The system cares about more than how many tasks got finished. It has to keep watching:

- whether work is flowing smoothly;
- which stage is the bottleneck;
- which tasks have been waiting too long;
- which Agents keep failing;
- which decisions have sat untouched;
- where the rework rate is too high;
- whether the project is drifting off target.

#### Policy-driven, not approve-every-step

Human-in-the-Loop does not mean a person confirms every single Agent action.

Based on task risk, permissions, cost, confidence, and business impact, the system dynamically chooses among:

- execute automatically;
- execute and notify;
- Agent cross-review;
- human spot check;
- mandatory human approval;
- multi-party sign-off;
- human takeover.

#### Everything is traceable

Every plan, assignment, execution, edit, approval, and release leaves a complete record.

The system must be able to answer:

- who did what;
- why they did it;
- what context was used;
- which tools were called;
- what came out of it;
- who approved the critical decisions;
- how the system recovered after a failure;
- whether the final delivery met the goal.

---

## 4. Target Users

### 4.1 Enterprise engineering teams

For engineering organizations with distinct product, development, QA, ops, and security roles.

What they need:

- automatic breakdown and assignment of engineering work;
- integration with in-house engineering Agents;
- management of multi-person and multi-Agent collaboration;
- control over production releases and data access;
- detection of project risks and delivery bottlenecks;
- lower coordination overhead for the project manager.

---

### 4.2 OPCs and one-person companies

For companies run by a single founder or a handful of core members.

What they need:

- one person running several projects;
- multiple Agents covering product, engineering, QA, research, and operations work;
- less manual task updating and progress-chasing;
- getting from idea to delivery quickly, end to end;
- staying in control at the decisive moments.

---

### 4.3 Small startup teams

For small teams that iterate fast and where role boundaries are fuzzy.

What they need:

- fast project creation;
- an execution plan that forms itself;
- dynamic assignment of work to people or Agents;
- low configuration cost for the project management tool;
- freedom from the administrative weight of a full Jira process.

---

### 4.4 Enterprise project leaders

Project managers, product owners, engineering leads, and business owners.

What they need:

- a read on project health;
- a place to handle the decisions that require a human;
- early warning on delays, blockers, and cost anomalies;
- visibility into what the Agents are doing;
- control over high-risk operations.

---

## 5. Core Usage Flow

The full project lifecycle in Autonomous Project OS:

```
Requirement arrives
   ↓
AI analysis and clarification
   ↓
Human confirms the requirement goal
   ↓
AI generates the project plan
   ↓
Human confirms key solutions and constraints
   ↓
Work breakdown and resource assignment
   ↓
Mixed Human / Agent execution
   ↓
Continuous monitoring and failure recovery
   ↓
Automated testing and layered review
   ↓
Human confirms high-risk delivery
   ↓
Release and business acceptance
   ↓
Knowledge capture and policy refinement
```

The recommended set of six project stages:

```
Intake
Planning
Execution
Review
Release
Done
```

Human Gates show up as card states, decision items, and approval markers — not as a separate board column for each one.

---

## 6. Core Domain Objects

Autonomous Project OS should not model everything around Task. It needs the following core objects.

### 6.1 Project

The top-level container for a project.

Holds:

- project name;
- project goal;
- project type;
- business owner;
- engineering lead;
- project members;
- project Agents;
- time range;
- budget;
- risk level;
- autonomy mode;
- project status;
- linked knowledge bases;
- linked code repositories;
- external system connections.

---

### 6.2 Requirement

Describes the business goal and what has to be delivered.

Holds:

- the raw requirement;
- the structured requirement statement;
- business background;
- target users;
- business value;
- success metrics;
- priority;
- acceptance criteria;
- constraints;
- deadline;
- related documents;
- requirement source;
- clarifying questions;
- confirmed assumptions.

---

### 6.3 Work Item

The single unit of work in a project.

Work Items can be configured with different types per business need:

- Requirement;
- Feature;
- Story;
- Task;
- Bug;
- Research;
- Review;
- Test;
- Incident;
- Decision;
- Approval;
- Release;
- Knowledge Item.

Every Work Item carries:

- title;
- description;
- type;
- status;
- priority;
- parent/child relationships;
- dependencies;
- owner;
- executor;
- planned dates;
- actual dates;
- risk level;
- acceptance criteria;
- linked artifacts;
- execution record.

---

### 6.4 Agent

An Agent is a first-class executor in the system, not just another tool.

Holds:

- Agent name;
- Agent type;
- model;
- capability description;
- Skill list;
- callable tools;
- permission scope;
- accessible resources;
- cost configuration;
- historical success rate;
- current load;
- suitable task types;
- max concurrency;
- timeout and retry policy;
- human owner.

---

### 6.5 Human

Human users are executors and decision-makers in equal measure.

Holds:

- user identity;
- organization and team;
- project role;
- domain expertise;
- what they can approve;
- data permissions;
- decision accountability;
- current workload;
- notification preferences.

---

### 6.6 Plan

The project execution plan generated by the Project Agent.

Holds:

- project scope;
- work breakdown structure;
- execution stages;
- dependency graph;
- critical path;
- suggested Agent assignments;
- human participation points;
- time and cost estimates;
- risk register;
- milestones;
- acceptance approach;
- release plan;
- rollback plan.

---

### 6.7 Decision

A structured decision that a human — or an authorized Agent — has to resolve.

Holds:

- the question to decide;
- what triggered it;
- the recommended option;
- alternatives;
- impact analysis;
- risk level;
- supporting evidence;
- the accountable decision-maker;
- the decision deadline;
- the outcome;
- any added constraints;
- the approval record.

---

### 6.8 Artifact

Deliverables produced while the project runs.

For example:

- code;
- pull requests;
- test reports;
- product documentation;
- technical designs;
- data analyses;
- page screenshots;
- deployment records;
- release notes;
- meeting notes.

---

### 6.9 Event

Every behavior in the system is recorded uniformly as an event.

For example:

- requirement created;
- plan generated;
- task assigned;
- Agent started;
- tool invoked;
- execution failed;
- human approved;
- status changed;
- code committed;
- release completed;
- business acceptance.

Events are what make a project traceable, replayable, and auditable.

---

### 6.10 Policy

Defines the automation boundary inside a project.

For example:

```
Touches the production database
→ requires DBA approval

Low-risk copy change
+ automated tests pass
+ cost below threshold
→ auto-approve
```

---

## 7. Information Architecture

```
Autonomous Project OS
│
├── Home
│   ├── My projects
│   ├── Awaiting my decision
│   ├── My tasks
│   ├── Agent activity
│   └── Risk alerts
│
├── Projects
│   ├── Project overview
│   ├── Autonomous Board
│   ├── Project plan
│   ├── Execution Graph
│   ├── Project members
│   ├── Agent team
│   ├── Decision log
│   ├── Project knowledge
│   └── Project settings
│
├── Decision Center
│   ├── Open
│   ├── Nearing timeout
│   ├── High risk
│   ├── Resolved
│   └── Decision policies
│
├── Agents
│   ├── Agent list
│   ├── Agent Workspace
│   ├── Skill
│   ├── Tool
│   ├── Run history
│   └── Agent evaluation
│
├── Knowledge
│   ├── Project knowledge
│   ├── Organization knowledge
│   ├── Decision knowledge
│   ├── Skill
│   └── Best practices
│
├── Analytics
│   ├── Project health
│   ├── Flow analysis
│   ├── Agent performance
│   ├── Human Intervention
│   ├── Cost analysis
│   └── Knowledge reuse
│
└── Administration
    ├── Organization management
    ├── Identity and permissions
    ├── Policy Engine
    ├── Model and Agent onboarding
    ├── External system integrations
    ├── Data security
    └── Audit log
```

---

## 8. Core Feature Design

### 8.1 Home Workspace

Signing in lands the user on a personal workspace.

What that workspace shows depends on the user's role.

#### Manager view

Shows:

- project health;
- high-risk projects;
- delay forecasts;
- decisions waiting on a human;
- Agent cost trend;
- team load;
- delivery status.

#### Project lead view

Shows:

- current project status;
- critical path;
- blocked tasks;
- plans awaiting approval;
- open exceptions;
- Agent work in progress;
- milestones coming due.

#### Developer view

Shows:

- tasks assigned to them;
- tasks an Agent finished that are waiting on review;
- tasks that need a human to take over;
- the relevant code and context;
- decisions to handle today.

#### OPC view

Shows:

- an overview of every project;
- what the Agents are working on right now;
- items that need them personally;
- what is expected to ship today;
- cost burn;
- project risks.

---

### 8.2 Requirement Center

#### 8.2.1 Multi-channel requirement intake

Requirements can be created by:

- filling in a form;
- natural language conversation;
- uploading a PRD or other document;
- extraction from meeting notes;
- extraction from email;
- import from customer feedback;
- sync from Jira, Plane, Linear, and similar systems;
- creation through the API or a webhook.

#### 8.2.2 AI requirement structuring

The Agent automatically turns a raw description into:

- requirement title;
- business background;
- the user's problem;
- business goal;
- user stories;
- functional scope;
- non-functional requirements;
- acceptance criteria;
- potential risks;
- dependencies;
- open questions that need clarification.

#### 8.2.3 Requirement completeness check

The system scores each requirement on:

- goal completeness;
- scope clarity;
- completeness of acceptance criteria;
- clarity of dependencies;
- how well risks have been identified;
- completeness of technical context.

#### 8.2.4 AI clarification

The Agent raises the clarifying questions that matter.

Questions are classified by how much they matter:

- answerable from the knowledge base automatically;
- resolvable by a default rule;
- can proceed after recording an assumption;
- must be confirmed by a human.

#### 8.2.5 Human Gate: requirement sign-off

A human can:

- approve the requirement;
- edit and then approve;
- add context;
- ask for re-analysis;
- reject;
- defer;
- delegate confirmation to someone else.

Only once the requirement is signed off does the project formally enter Planning.

---

### 8.3 Project Agent

The Project Agent is the project-level management and scheduling Agent.

#### 8.3.1 Project planning

From the requirement and the organization's context, it generates:

- project scope;
- stage breakdown;
- work breakdown;
- effort estimates;
- suggested technical approach;
- Agent and staffing needs;
- dependencies;
- critical path;
- schedule;
- risk register;
- milestones;
- budget estimate.

#### 8.3.2 Dynamic work breakdown

The Project Agent can decompose a requirement into a multi-level Work Item tree:

```
Requirement
├── Research
├── Design
├── Backend
│   ├── API
│   ├── Database
│   └── Unit Test
├── Frontend
│   ├── UI
│   └── Integration
├── Test
├── Review
└── Release
```

Breakdown should not be a one-shot event.

When new problems surface during execution, the Project Agent can:

- create follow-up tasks;
- split a task that turned out to be complex;
- merge duplicates;
- adjust dependencies;
- change priorities;
- update the plan.

#### 8.3.3 Execution Graph generation

The Project Agent turns task relationships into an Execution Graph.

A node can be:

- a human task;
- an Agent task;
- an approval node;
- an automation node;
- a wait node;
- a verification node;
- a release node.

An edge represents:

- a finish-to-start dependency;
- a data dependency;
- an approval dependency;
- a trigger relationship;
- a retry relationship;
- a rollback relationship.

#### 8.3.4 Intelligent scheduling

The Project Agent assigns work based on:

- Agent capability;
- Skill match;
- historical success rate;
- current load;
- context fit;
- permission scope;
- model cost;
- task deadline;
- risk level;
- whether human experience is required.

A task can be assigned to:

- one person;
- one Agent;
- several Agents running in parallel;
- an Agent to execute with a human to review;
- a human to execute with an Agent assisting;
- an Agent cluster;
- an external service.

#### 8.3.5 Progress maintenance

The Project Agent reads state from Agent Runs, code repositories, test systems, and external project systems, and updates task progress itself.

Users do not have to drag most cards by hand.

The system has to distinguish clearly between:

- automatic system updates;
- Agent updates;
- human updates;
- external system sync.

#### 8.3.6 Project summaries

The Project Agent can generate:

- a daily project summary;
- weekly reports;
- milestone reports;
- risk reports;
- delay explanations;
- Agent work reports;
- executive updates;
- project retrospectives.

---

### 8.4 Autonomous Board

The board is the main visualization of project Flow — but it is not the whole product.

#### 8.4.1 Default stages

Out of the box:

```
Intake
Planning
Execution
Review
Release
Done
```

An enterprise can configure different workflows per project type.

#### 8.4.2 Card content

Each card shows:

- title;
- Work Item type;
- priority;
- current stage;
- human owner;
- Agent executor;
- risk level;
- estimated completion;
- current progress;
- dependency status;
- Human Gate status;
- tokens and cost;
- time blocked;
- latest execution result.

#### 8.4.3 Human Gate markers

Cards must clearly display:

- Approval Required;
- Waiting for Decision;
- Human Reviewing;
- Human Took Over;
- Approved;
- Rejected;
- Escalated;
- Decision Overdue.

#### 8.4.4 Cards that move themselves

Card state is driven primarily by system events.

For example:

```
Task created
→ Ready

Agent Run starts
→ Executing

Agent output complete
→ Reviewing

Automated tests pass
→ Waiting for Release

Release complete
→ Acceptance
```

Users can still change state by hand, but the system should record why.

#### 8.4.5 Board filters and views

Filterable by:

- project;
- stage;
- Work Item type;
- Human;
- Agent;
- risk;
- priority;
- Human Gate;
- blocked status;
- due date;
- cost;
- task source.

Multiple views are supported:

- Kanban;
- List;
- Timeline;
- Calendar;
- Execution Graph;
- Agent View;
- Human Decision View;
- Risk View;
- Delivery View.

---

### 8.5 Agent Workspace

Every Agent needs a workspace of its own.

#### 8.5.1 Agent profile

Shows:

- what the Agent is for;
- the domain it owns;
- model;
- Skills;
- Tools;
- permissions;
- cost;
- success rate;
- current load;
- recent tasks.

#### 8.5.2 Agent task queue

Contains:

- queued tasks;
- running tasks;
- tasks waiting on dependencies;
- tasks waiting on a human decision;
- failed tasks;
- completed tasks.

#### 8.5.3 Agent Run

Each execution forms its own Run.

A Run holds:

- the input goal;
- context;
- the model used;
- the Skills used;
- tool calls;
- execution events;
- output;
- tokens;
- cost;
- elapsed time;
- errors;
- retry history;
- human interventions;
- artifacts;
- final status.

#### 8.5.4 Agent collaboration

Supported patterns:

- a lead Agent delegating to sub-Agents;
- multiple Agents in parallel;
- aggregation of Agent results;
- Agent cross-review;
- a Reviewer Agent;
- one Agent asking another for more information;
- arbitration of conflicting results;
- handoff after failure.

#### 8.5.5 Human takeover

While an Agent is running, a human can:

- pause it;
- add constraints;
- change the context;
- terminate it;
- reassign the work;
- take over directly;
- ask for a re-plan;
- resume Agent execution.

---

### 8.6 Flow Engine

The Flow Engine moves project state forward; it does not merely store it.

#### 8.6.1 State management

It manages state for:

- Project;
- Requirement;
- Work Item;
- Agent Run;
- Decision;
- Approval;
- Artifact;
- Release.

#### 8.6.2 Dependency management

Supported:

- Finish-to-Start;
- Start-to-Start;
- artifact dependency;
- human-decision dependency;
- permission dependency;
- external system dependency;
- data-readiness dependency.

#### 8.6.3 WIP control

Configurable limits on:

- maximum tasks per stage;
- maximum concurrency per Agent;
- maximum open decisions per person;
- maximum running cost per project;
- concurrency per task type.

#### 8.6.4 Blocker detection

The system detects, on its own:

- task timeouts;
- unmet dependencies;
- an Agent failing repeatedly;
- a decision waiting too long;
- an external service being unavailable;
- cost over budget;
- insufficient permissions;
- conflicting results from multiple Agents;
- a task with no event activity for a long stretch.

#### 8.6.5 Flow Recovery

Per policy, the system can automatically:

- retry;
- switch to a different Agent;
- drop to a cheaper model;
- add a Reviewer;
- split the task;
- roll back a step;
- request a human decision;
- hand off to a person;
- terminate the task.

#### 8.6.6 Delay forecasting

Based on:

- current progress;
- historical Cycle Time;
- Agent success rate;
- dependency status;
- time spent blocked;
- decision wait time;
- remaining work;

the system forecasts the probability that a project or a task will slip.

---

### 8.7 Human Decision Center

The Human Decision Center is the single entry point for everything that needs a human.

#### 8.7.1 Decision inbox

Shows:

- awaiting me;
- nearing timeout;
- high risk;
- requiring multi-party sign-off;
- delegated;
- resolved;
- repeat decisions the Agent suggests automating.

#### 8.7.2 Decision card

Every decision card should answer:

- what has to be decided;
- why a human has to decide it;
- what the Agent recommends;
- what the alternatives are;
- what each option implies;
- what happens if nothing is done;
- the latest it can be handled;
- where the supporting evidence lives.

#### 8.7.3 Decision actions

Supported:

- Approve;
- Approve with Constraints;
- Edit;
- Request Revision;
- Delegate;
- Take Over;
- Pause;
- Reject;
- Terminate;
- Create Policy.

#### 8.7.4 Decision deadlines

Each decision is configured with:

- a decision deadline;
- a reminder policy;
- an escalation path;
- a default handling rule;
- whether a timeout pauses the project.

#### 8.7.5 Decision accountability

The system identifies the accountable party from project roles and Policy.

For example:

- business scope change → product owner;
- architecture change → engineering lead;
- database change → DBA;
- security exception → security lead;
- over budget → project sponsor;
- production release → release manager.

---

### 8.8 Human-in-the-Loop

Human-in-the-Loop runs through the entire project lifecycle.

#### 8.8.1 Requirement stage

The Agent handles:

- structuring the requirement;
- filling in context;
- raising questions;
- generating acceptance criteria.

The human handles:

- confirming the goal;
- judging business value;
- confirming priority;
- confirming the critical business rules.

#### 8.8.2 Planning stage

The Agent handles:

- breaking down the work;
- generating dependencies;
- estimating time and cost;
- recommending executors.

The human handles:

- confirming scope;
- confirming the key solutions;
- confirming the delivery commitment;
- confirming the high-risk paths.

#### 8.8.3 Scheduling stage

By default the Agent assigns work on its own.

A human confirmation is required when:

- an expensive model is used;
- it consumes the time of key personnel;
- it requires cross-team collaboration;
- it uses sensitive resources;
- the Agent's capability falls short;
- cost exceeds budget.

#### 8.8.4 Execution stage

By default the Agent executes autonomously.

A human is pulled in when:

- consecutive failures exceed the threshold;
- execution has clearly diverged from the plan;
- a requirement conflict is discovered;
- an irreversible operation is involved;
- multiple Agents reach conflicting conclusions;
- an operation beyond granted permissions is needed;
- cost is growing abnormally;
- the task has been blocked for a long time.

#### 8.8.5 Review stage

Graded by risk.

Low-risk task

```
Agent executes
→ automated verification
→ Review Agent
→ auto-approved
```

Medium-risk task

```
Agent executes
→ automated tests
→ Review Agent
→ human spot check or quick confirmation
```

High-risk task

```
Agent executes
→ multi-Agent cross-review
→ full test suite
→ mandatory review by a named human
```

#### 8.8.6 Release stage

- Development: Agents may release automatically;
- Testing: automatic release with a notification;
- Staging: handled per the risk policy;
- Production: approval required by default, unless the enterprise's auto-release policy is satisfied.

#### 8.8.7 Acceptance stage

The Agent verifies the technical result.

The human judges:

- whether the business goal is met;
- whether it holds up in real usage;
- whether the project can formally close;
- whether further work is warranted.

#### 8.8.8 Learning stage

The Agent automatically produces:

- a project retrospective;
- bottleneck analysis;
- Agent performance;
- a decision summary;
- Skill candidates;
- Policy candidates.

The human confirms which lessons make it into the organization's knowledge base and default rules.

---

### 8.9 Policy & Governance Engine

The Policy Engine decides what may run automatically and what needs a human.

#### 8.9.1 Policy conditions

Configurable on:

- project type;
- Work Item type;
- risk level;
- data sensitivity;
- target environment;
- Agent type;
- Agent confidence;
- historical success rate;
- model cost;
- cumulative budget;
- test results;
- security scan;
- blast radius;
- failure count;
- reversibility;
- whether external customers are involved.

#### 8.9.2 Policy actions

Supported:

- Allow;
- Allow and Notify;
- Require Agent Review;
- Require Human Review;
- Require Multiple Approvals;
- Ask;
- Pause;
- Deny;
- Escalate;
- Transfer to Human.

#### 8.9.3 Policy examples

```
IF:
task risk = low
AND automated tests pass
AND the Review Agent approves
AND cost < 10 USD
THEN:
auto-approve and notify the owner
```

```
IF:
the production database is involved
THEN:
require DBA approval
```

```
IF:
the Agent fails 3 times in a row
THEN:
pause the task and ask the engineering lead to step in
```

#### 8.9.4 Autonomy levels

Each project picks one:

**Human-led**

The Agent advises; humans make the calls that matter.

Suited to:

- high-risk projects;
- new lines of business;
- Agents whose capability is not yet proven;
- heavily regulated settings.

**Agent-led with Approval**

The Agent plans and executes on its own; humans approve at the key points.

This is the default mode.

**Agent-autonomous**

The Agent plans, executes, and verifies on its own, and only calls a human when something goes wrong.

Suited to:

- low-risk work;
- repetitive work;
- test or sandbox environments;
- mature, proven processes.

---

### 8.10 Review & Quality Center

#### 8.10.1 Automated verification

Supported:

- unit tests;
- integration tests;
- UI tests;
- lint and code standards;
- security scanning;
- performance testing;
- data validation;
- documentation completeness checks;
- acceptance-criteria verification.

#### 8.10.2 Multi-Agent review

Configurable reviewers:

- Code Review Agent;
- Security Agent;
- Architecture Agent;
- Test Agent;
- Product Review Agent.

Several Agents can review the same artifact independently, and the system aggregates their verdicts.

#### 8.10.3 Quality gates

Configurable on:

- test coverage;
- number of severe bugs;
- security vulnerability severity;
- performance thresholds;
- human approval;
- agreement across Agents;
- documentation completeness.

Work that fails a quality gate cannot enter Release.

---

### 8.11 Release Center

#### 8.11.1 Release plan

Generated automatically:

- release scope;
- change list;
- impact analysis;
- release steps;
- checklist;
- canary plan;
- rollback plan;
- notification plan.

#### 8.11.2 Environment management

Supported:

- Development;
- Testing;
- Staging;
- Production;
- custom environments.

#### 8.11.3 Release approval

Environment, risk, and Policy together decide between:

- automatic release;
- release then notify;
- single approver;
- multi-party sign-off;
- manual execution.

#### 8.11.4 Release monitoring

After a release, the system automatically watches:

- service status;
- error rate;
- performance;
- logs;
- user feedback;
- core business metrics.

On an anomaly it can automatically:

- halt the release;
- roll back;
- open an Incident;
- notify the owner;
- start a diagnosis Agent.

---

### 8.12 Knowledge Center

#### 8.12.1 Project knowledge

Retains:

- requirement background;
- technical approach;
- decision records;
- project documents;
- code explanations;
- test records;
- failure causes;
- release experience;
- project retrospectives.

#### 8.12.2 Automatic knowledge extraction

While the project runs, the system spots:

- reusable solutions;
- recurring problems;
- decision patterns;
- effective prompts;
- Agent best practices;
- Skill candidates;
- Policy candidates;
- risk patterns.

#### 8.12.3 Knowledge publication flow

```
Candidate
→ AI cleanup
→ Human Review
→ Published
→ Reused
→ Updated / Deprecated
```

#### 8.12.4 Project memory

The Project Agent has ongoing access to:

- why this project exists;
- why the current approach was chosen;
- which approaches were rejected, and when;
- which risks have been accepted;
- which constraints cannot move;
- the history of executions and decisions.

---

### 8.13 Delivery Analytics

The system does not just count finished tasks; it analyzes the whole delivery system.

#### 8.13.1 Flow metrics

Including:

- Lead Time;
- Cycle Time;
- Throughput;
- WIP;
- Flow Efficiency;
- Blocked Time;
- Decision Waiting Time;
- Rework Rate;
- On-time Delivery Rate.

#### 8.13.2 Agent metrics

Including:

- Agent Success Rate;
- First-pass Success Rate;
- Retry Rate;
- Human Intervention Rate;
- Task Takeover Rate;
- Average Cost;
- Token Consumption;
- Average Execution Time;
- Review Pass Rate;
- Agent Utilization.

#### 8.13.3 Human-in-the-Loop metrics

Including:

- number of human decisions;
- average decision time;
- number of decisions that timed out;
- number of repeat decisions;
- share of decisions handled automatically;
- number of human takeovers;
- share of human involvement per stage;
- time blocked waiting on a human.

#### 8.13.4 Project health

The system combines the following into a project health score:

- progress;
- quality;
- risk;
- cost;
- dependencies;
- blockers;
- decision wait;
- Agent stability;
- staffing load;
- requirement churn.

#### 8.13.5 Knowledge metrics

Including:

- Knowledge Reuse Rate;
- Skill Reuse Rate;
- Policy Reuse Rate;
- number of references to past projects;
- amount of new organization knowledge;
- amount of knowledge that went stale.

---

## 9. Integrations

### 9.1 Project management systems

Connectors for:

- Jira;
- Plane;
- Linear;
- Monday;
- Asana;
- GitHub Projects;
- GitLab Issues;
- in-house project systems.

Two-way sync is required for:

- projects;
- Work Items;
- status;
- owners;
- comments;
- due dates;
- artifact links.

A source of truth has to be defined, or the systems will overwrite each other.

---

### 9.2 Code and engineering systems

Supported:

- GitHub;
- GitLab;
- Bitbucket;
- Jenkins;
- GitHub Actions;
- GitLab CI;
- SonarQube;
- Sentry;
- Kubernetes;
- cloud platforms;
- in-house release systems.

---

### 9.3 Agents and models

Onboarding supported for:

- Codex;
- Claude Code;
- OpenHands;
- Cursor Agent;
- Browser Agent;
- Data Agent;
- in-house Agents;
- MCP Server;
- custom Agent Runtimes.

A unified Agent Protocol is required.

It describes, uniformly:

- Agent capabilities;
- task input;
- execution status;
- events;
- artifacts;
- permissions;
- cost;
- errors;
- requests for human intervention.

---

### 9.4 Enterprise collaboration systems

Supported:

- Slack;
- Microsoft Teams;
- Feishu / Lark;
- WeCom;
- email;
- Google Calendar;
- Outlook Calendar;
- in-house notification systems.

---

### 9.5 Enterprise data systems

Reachable through governed connectors:

- databases;
- data warehouses;
- CRM;
- ERP;
- ticketing systems;
- knowledge bases;
- document systems;
- BI platforms.

---

## 10. Permissions and Security

### 10.1 Identity types

Uniformly supported:

```
Identity
├── Human
├── Agent
├── Service
└── External Integration
```

### 10.2 Permission model

Recommended:

- RBAC;
- ABAC;
- Capability;
- Project Scope;
- Resource Scope.

### 10.3 Agent permissions

Agent permissions must be configured independently of any human user's.

For example:

```
Review Agent

Allowed:
- read code
- read PRs
- create review comments

Denied:
- merge code
- change production configuration
```

### 10.4 High-risk operations

The following require extra governance by default:

- modifying production data;
- deleting resources;
- changing permissions;
- accessing sensitive data;
- sending information outside the company;
- executing payments;
- releasing to production;
- changing security policies;
- using expensive resources.

### 10.5 Audit log

Every significant action must record:

- the actor;
- the identity type;
- the timestamp;
- the input;
- the operation;
- the target resource;
- the Policy verdict;
- the approval record;
- the result;
- the failure cause;
- the associated project and task.

---

## 11. Notifications and Escalation

Notifications should be designed around "something needs your action," not around shipping a firehose of Agent logs.

### Notification types

- a decision is needed;
- a decision is about to time out;
- project risk has risen;
- an Agent is failing repeatedly;
- a task has been blocked for a long time;
- cost is approaching its limit;
- a key milestone completed;
- a release anomaly;
- a request for human takeover;
- a request for business acceptance.

### Escalation rules

For example:

```
Decision waiting 4 hours
→ remind the accountable person

Waiting 8 hours
→ remind the project lead

Waiting 24 hours
→ notify their manager and pause the critical path
```

---

## 12. MVP Scope

The first release should not attempt the complete Autonomous Project OS. It should prove out the core loop.

### 12.1 MVP goal

Validate this hypothesis:

> After a user files one requirement, the Project Agent can turn it into an executable plan, assign it to people or Agents, request human decisions at the key points, and ultimately drive the requirement to completion.

### 12.2 What the MVP must include

#### Projects and requirements

- create a project;
- file a requirement;
- AI requirement structuring;
- AI clarifying questions;
- human requirement sign-off.

#### Intelligent planning

- AI work breakdown;
- dependency generation;
- execution plan generation;
- human plan approval.

#### Autonomous Board

- the six-stage board;
- Work Items;
- Human / Agent assignee;
- Human Gate markers;
- automatic status updates;
- blocked state.

#### Agent management

- register an Agent;
- configure capabilities and permissions;
- assign tasks;
- Agent Runs;
- execution events;
- artifact return;
- retries and failures.

#### Human Decision Center

- decision cards;
- Approve;
- Approve with Constraints;
- Request Revision;
- Take Over;
- Reject.

#### Policy Engine, basic version

Configurable rules for:

- which tasks run automatically;
- which tasks need approval;
- how many failures trigger a request for a human;
- which environments always require approval.

#### Basic Analytics

- project progress;
- Lead Time;
- Blocked Time;
- Agent success rate;
- number of human interventions;
- Agent cost.

#### First wave of integrations

Suggested priority:

- GitHub;
- one Code Agent;
- Slack or Feishu;
- Jira or Plane.

---

## 13. Out of Scope for the MVP

Not a priority for the first release:

- a full Agent Marketplace;
- elaborate financial budgeting;
- multi-level enterprise org structures;
- a complete knowledge graph;
- highly customizable BI;
- large-scale cross-project resource scheduling;
- full ERP / CRM integration;
- a complex low-code Workflow Designer;
- fully autonomous production releases;
- Agents editing Policy on their own.

These can be added incrementally once the core loop is proven.

---

## 14. Core Pages

The MVP should design these pages first:

1. project list;
2. project overview;
3. requirement intake and AI clarification;
4. plan confirmation;
5. Autonomous Board;
6. Work Item detail;
7. Execution Graph;
8. Agent Workspace;
9. Agent Run detail;
10. Human Decision Center;
11. decision detail;
12. project Analytics;
13. Policy configuration;
14. project integration settings.

---

## 15. Key Differentiators

### Versus a traditional Kanban

Traditional Kanban:

- the user creates tasks;
- the user assigns tasks;
- the user updates status;
- the user notices blockers;
- the user pushes the process along.

Autonomous Project OS:

- the Agent understands the requirement;
- the Agent generates the plan;
- the Agent assigns the work;
- the Agent executes the work;
- the system updates status automatically;
- the Agent detects blockers and recovers from them;
- humans handle only the decisions that matter.

### Versus Jira plus an AI assistant

Jira plus an AI assistant is essentially:

> AI helps the user use Jira faster.

Autonomous Project OS is:

> The Agent itself becomes the executor and coordinator, and the system is redesigned around how Agents run, are governed, and work together.

### Versus a single Code Agent

A single Code Agent answers:

> How do I get one engineering task done?

Autonomous Project OS answers:

> How do I continuously turn business requirements into governed, traceable, collaborative Human–Agent execution flows?

---

## 16. Product Value

### For the enterprise

- lower project coordination cost;
- more transparent project state;
- less manual board updating;
- shorter time from requirement to delivery;
- more controllable Agent usage;
- an enterprise-grade Agent governance system;
- reusable project knowledge that actually accumulates;
- lower risk of Agents going off the rails or exceeding their authority.

### For the project manager

The project manager moves from:

- moving tickets around;
- chasing progress;
- updating status;
- collecting daily reports;
- coordinating routine dependencies;

to:

- defining goals;
- designing rules;
- managing risk;
- handling the important exceptions;
- improving the project system itself.

### For the OPC

- one person managing many Agents;
- an individual's capability extended into a virtual team;
- less project management overhead;
- ideas turned into execution plans quickly;
- final control retained where the risk is.

---

## 17. Key Metrics

### Business metrics

- projects created;
- active projects;
- on-time delivery rate;
- requirement-to-delivery time;
- user retention;
- enterprise paid conversion.

### Efficiency metrics

- share of tasks broken down automatically;
- share of assignments made automatically;
- share of status updates made automatically;
- share of work completed by Agents;
- reduction in manual coordination time;
- average decision handling time;
- reduction in project blocked time.

### Agent metrics

- Agent task success rate;
- first-pass success rate;
- human takeover rate;
- average cost per task;
- average retries;
- review pass rate.

### Governance metrics

- approval coverage for high-risk operations;
- number of unauthorized operations;
- decision traceability rate;
- audit coverage for production operations;
- share of cases Policy handles automatically;
- reduction in repetitive manual approvals.

---

## 18. Product Boundaries

Autonomous Project OS is not out to replace every specialized tool.

It does not need to reimplement:

- code hosting;
- CI/CD;
- document editors;
- enterprise chat;
- data warehouses;
- a full ERP;
- a full CRM.

Its role is:

> To connect project goals, people, Agents, tools, knowledge, and decisions — and to keep driving project Flow.

So it looks more like the control plane and runtime for enterprise projects than like a collection of every execution capability.

---

## 19. Summary

Autonomous Project OS is not a traditional board with AI features bolted on, and it is not a project assistant whose job is auto-splitting tasks.

It is a project runtime for hybrid Human–Agent teams.

In this system:

- the Requirement defines the business value to be delivered;
- the Project Agent plans and keeps things moving;
- Humans and Agents are both executors;
- the Flow Engine manages the real flow of the project;
- the Policy Engine defines the boundary of Agent autonomy;
- the Human Decision Center absorbs the decisions that matter;
- the Agent Workspace manages how Agents execute;
- the Knowledge Center turns project experience into an organizational asset;
- Delivery Analytics keeps finding and removing delivery bottlenecks.

What the product is ultimately after is not humans leaving the project — it is a redistribution of responsibility between humans and Agents:

```
Agent:
plan, break down, assign, execute, monitor, retry, sync, summarize

Human:
define goals, judge value, control risk, handle exceptions, carry accountability, accept results
```

The core value of Autonomous Project OS, in one line:

> Let the project keep flowing forward on its own, while humans keep hold of the goals, the risk, and the final say.
