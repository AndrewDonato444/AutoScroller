# Personas

Create or update user personas that inform every feature spec.

## Usage

```
/personas                                    # Create personas (reads vision for context)
/personas "busy real estate broker"          # Create from description
/personas update                             # Revise existing personas
/personas add "office admin who manages deals for brokers"  # Add a new persona
```

---

## What Personas Are For

Personas are reference files that `/spec-first` reads before writing any spec. They answer:
- **What language does this person use?** (Labels and copy should match)
- **How patient are they?** (Determines flow length and complexity)
- **What's their context?** (Mobile in the field? Desktop all day? Between meetings?)
- **What do they already know?** (Determines onboarding needs and default behavior)

Personas are NOT fictional marketing profiles. Skip the stock photo and the name. Focus on behaviors, constraints, and vocabulary.

---

## Behavior: Create

### Step 1: Read Context

| File | What You Learn |
|------|---------------|
| `.specs/vision.md` | Target users, app purpose, design principles |
| Existing codebase | Who the current UI seems designed for |

If vision.md exists and describes target users, derive personas from it.
If nothing exists, ask:

```
Who uses this app? Tell me:

1. Who is the primary user? (role, not name)
2. What's their typical day like? (busy/relaxed, desk/mobile, technical/non-technical)
3. Is there a secondary user with different needs?
4. Who is this NOT for? (anti-persona)
```

### Step 2: Write Personas

Create 2-3 files in `.specs/personas/`:

| File | Purpose |
|------|---------|
| `primary.md` | The main user. Every feature must work for this person. |
| `secondary.md` | A different type of user with different needs (if applicable). |
| `anti-persona.md` | Who you're NOT building for. Prevents scope creep. |

Most projects need 2 (primary + anti-persona). Only add secondary if the app genuinely serves two different user types (e.g., both brokers and admins).

### Step 3: Report

```markdown
## Personas Created

**Primary**: [role] — [one-line summary of their key constraint]
**Anti-persona**: [role] — [why we're not building for them]

Files:
- `.specs/personas/primary.md`
- `.specs/personas/anti-persona.md`

These will be loaded by /spec-first when writing feature specs.
```

---

## Behavior: Update

1. Read existing personas
2. Read `.specs/learnings/` for any user-behavior insights discovered during implementation
3. Read vision.md for any changes to target audience
4. Update personas, noting what changed and why

---

## Behavior: Add

1. Read existing personas to avoid overlap
2. Create a new persona file
3. Explain how this persona differs from existing ones

---

## Persona File Format

```markdown
# [Role — e.g., "Commercial Real Estate Broker"]

## Context

- [How they spend their day]
- [What devices/environment they work in]
- [Technical sophistication level]
- [How many tools they juggle]

## What They Care About

- [Their actual goal — not "use the app" but the real-world outcome]
- [What makes them choose this tool over alternatives/spreadsheets]
- [What would make them recommend it to a colleague]

## What Frustrates Them

- [Specific interaction patterns they hate]
- [Things that waste their time]
- [Complexity they don't want to deal with]

## Their Vocabulary

- [Terms they use vs. developer/technical terms]
- [e.g., "deal" not "transaction", "comp" not "comparable sale"]
- [This directly shapes UI labels and copy]

## Patience Level

[One of: Very Low / Low / Medium / High]
[One sentence explaining why — e.g., "Between client calls all day, will abandon any flow that takes more than 30 seconds"]

## Success Metric

[How this person measures whether the app is working for them]
[e.g., "Can I find the comp I need before my client meeting in 10 minutes?"]
```

### Anti-Persona Format

```markdown
# Anti-Persona: [Role]

## Who This Is

- [Description of the user type we're NOT targeting]

## Why They're Out of Scope

- [What they'd need that would distort the product]
- [How serving them would hurt the primary persona's experience]

## What to Say If Requested

[How to redirect — e.g., "If someone asks for a public API, that's this persona. We're not building that in v1. Note it in roadmap as future/maybe."]
```

---

## How Personas Are Used

### By `/spec-first`
Before writing Gherkin scenarios and mockups:
1. Reads all persona files from `.specs/personas/`
2. Uses primary persona's vocabulary for UI labels
3. Uses patience level to gauge flow length
4. Uses frustrations to avoid known pain patterns
5. After writing the spec, reviews it through the persona lens and revises

### By `/design-tokens`
- Persona patience level → influences information density → influences spacing base
- Persona technical level → influences terminology in component naming
- Persona context (mobile/desktop) → influences breakpoint priorities

### By the developer (you)
- When deciding between "simple but limited" and "powerful but complex," the persona tells you which to pick
- When naming a button or writing error text, the persona tells you what words to use

---

## Examples

### Primary: Busy Broker
```markdown
# Commercial Real Estate Broker

## Context
- On the phone or in meetings 6 hours/day
- Uses the app in 5-minute bursts between calls
- Laptop at desk, phone in the field
- Not technical — learned Excel out of necessity, not interest

## What They Care About
- Finding the right comp before a client meeting
- Not looking unprepared in front of clients
- Closing deals faster than competing brokers

## What Frustrates Them
- Can't find something they know is "in there somewhere"
- Flows that require more than 2-3 clicks
- Jargon or settings they don't understand
- Having to re-enter information the app should already know

## Their Vocabulary
- "Comp" not "comparable sale analysis"
- "Deal" not "transaction"
- "Contact" not "stakeholder entity"
- "My deals" not "assigned pipeline items"

## Patience Level
Very Low — between calls, will close the tab if it takes more than 10 seconds to find what they need.

## Success Metric
"I pulled the right comp in under a minute and looked prepared in front of my client."
```

### Anti-Persona: Developer
```markdown
# Anti-Persona: Developer/API Consumer

## Who This Is
- A developer who wants to integrate this data into their own tools
- Wants an API, webhooks, bulk export, custom queries

## Why They're Out of Scope
- Building for API consumers means auth tokens, rate limiting, documentation, versioning
- That's a whole product, not a feature
- It would slow down iteration on the broker experience

## What to Say If Requested
"API access is a different product. Note it in roadmap as Phase N / future consideration. Don't let it influence the UI or data model of v1."
```

---

## File Locations

| File | Purpose |
|------|---------|
| `.specs/personas/primary.md` | Main user persona |
| `.specs/personas/secondary.md` | Second user type (if needed) |
| `.specs/personas/anti-persona.md` | Who you're NOT building for |
