# Design Tokens Management

Create or update the design tokens for your project. This command produces a tailored design system, not a generic template.

## Usage

```
/design-tokens                              # Create tokens (reads vision + personas for context)
/design-tokens init                         # Same as above
/design-tokens update primary to #FF6B6B    # Update specific tokens
/design-tokens import from tailwind.config  # Extract from existing config
/design-tokens import from styles/vars.css  # Extract from CSS variables
```

---

## Behavior: Create New Tokens

If `.specs/design-system/tokens.md` doesn't exist (or is still the unmodified template):

### Step 1: Read Context

Before choosing any values, read whatever exists:

| File | What You Learn |
|------|---------------|
| `.specs/vision.md` | App purpose, target users, design principles, what kind of tool this is |
| `.specs/personas/*.md` | Who uses this — their context, patience level, technical sophistication |
| `package.json` / project files | Tech stack (Tailwind? CSS modules? styled-components?) |
| Existing CSS/theme files | Any values already in use |

If none of these exist, ask the user:

```
I need a bit of context to create a good design system:

1. What kind of app is this? (e.g., "enterprise dashboard", "consumer social app", "developer tool")
2. One word for the vibe: professional / playful / minimal / bold / warm / technical
3. Do you have a brand color? (hex, or describe it — "dark blue", "forest green")

Or just describe it however you want and I'll derive the rest.
```

### Step 2: Determine Personality

Based on context, classify the app into one of these personality profiles. This drives every token choice:

| Personality | Radii | Spacing | Palette | Typography | Shadow | Example Apps |
|-------------|-------|---------|---------|------------|--------|-------------|
| **Professional** | Small (2-6px) | Tight (4px base) | Muted, high-contrast neutrals, single accent | System fonts or clean sans-serif, smaller sizes | Subtle, low elevation | Jira, Linear, Bloomberg Terminal |
| **Friendly** | Medium-Large (8-12px) | Comfortable (8px base) | Warm, approachable, 2-3 accent colors | Rounded sans-serif, generous sizes | Medium, cards feel lifted | Notion, Slack, Spotify |
| **Minimal** | Small-Medium (4-8px) | Generous whitespace (8px base, large section gaps) | Near-monochrome, one careful accent | Clean, lots of weight contrast | Almost none, borders instead | Apple.com, Linear, iA Writer |
| **Bold / Consumer** | Large (12-16px+) | Generous (8px base) | Vivid, high saturation, gradient-friendly | Large display type, heavy/light contrast | Large, dramatic | Vercel, Stripe, Arc browser |
| **Technical / Data** | Minimal (0-4px) | Tight-compact (4px base) | Cool neutrals, functional color only | Monospace accents, small body text | Flat, border-driven | GitHub, Grafana, terminal apps |

Pick the closest match. If the vision says "professional and clean" → Professional. If personas are non-technical → Friendly. State your choice and why.

### Step 3: Build the Palette

**Start from one color and derive the rest.** Do not pick colors independently.

1. **Primary color**: From brand, or derive from personality:
   - Professional → deep blue, slate, indigo
   - Friendly → teal, coral, warm purple
   - Minimal → black or single muted accent
   - Bold → vivid blue, purple, orange
   - Technical → gray-blue, green (terminal vibes)

2. **Derive the system from primary**:
   - `primary-hover`: 10% darker
   - `primary-light`: 90% lighter (for backgrounds)
   - `secondary`: Complementary or analogous to primary (not random)
   - Neutrals: Tint your grays with a hint of the primary hue (warm primary → warm grays, cool primary → cool grays). Pure gray (#6B7280) looks dead next to a warm primary.
   - Semantic colors (success/warning/error): Use standard hues (green/amber/red) but adjust saturation to match overall palette energy. Muted palette → muted semantics. Vivid palette → vivid semantics.

3. **Check contrast**: `color-text` on `color-background` must be at least 4.5:1 (WCAG AA). `color-text-secondary` must be at least 3:1 for large text.

### Step 4: Choose Constraints (Fewer Tokens = Better System)

**For a v1, you need less than you think:**

| Category | v1 Needs | Skip Until v2 |
|----------|----------|----------------|
| Colors | Primary + hover + light, 3-4 neutrals, 3 semantic | Secondary color, gradients, dark mode |
| Typography | 1 font family, 4-5 sizes (sm, base, lg, xl, 2xl), 3 weights | Display fonts, 2xl+, font-light |
| Spacing | 6 values (1, 2, 3, 4, 6, 8) | spacing-0, spacing-5, spacing-10+ |
| Radii | 3 values (sm, md, lg) + full | none, xl, 2xl |
| Shadows | 2 values (sm, lg) | md, xl |
| Z-index | 3 layers (base, dropdown, modal) | sticky, toast, max |
| Animation | 1 duration, 1 easing | Multiple speeds |

**Be opinionated.** A design system with 5 spacing values that are always used correctly beats one with 12 values used inconsistently. You can always add more later.

### Step 5: Write tokens.md

Write `.specs/design-system/tokens.md` with:
- The chosen personality and a one-line rationale
- Every token with its value AND usage guidance
- A "Why These Choices" section explaining the derivation
- A "What's Intentionally Missing" section so the user knows what's deferred

### Step 6: Create Cursor Rule

Create/update `.cursor/rules/design-tokens.mdc` with the actual token names for this project.

### Step 7: Report

```markdown
## Design System Created

**Personality**: [Professional / Friendly / Minimal / Bold / Technical]
**Rationale**: [1 sentence — "Vision says 'data-dense but not cluttered' for brokers, so Professional with tight spacing"]

**Primary**: [color swatch description + hex]
**Derived from**: [vision.md / user input / persona context]

### Token Counts
- Colors: [n] tokens
- Typography: [n] tokens (1 family)
- Spacing: [n] values
- Total: [n] tokens

### Intentionally Deferred
- Dark mode
- Secondary accent color
- [etc.]

Files created:
- `.specs/design-system/tokens.md`
- `.cursor/rules/design-tokens.mdc`
```

---

## Behavior: Update Existing Tokens

If tokens.md already exists and has been customized:

1. Read current tokens.md
2. Apply requested changes
3. Check that changes don't break contrast ratios
4. If token names changed, update `.cursor/rules/design-tokens.mdc`
5. List what changed, including any derived values that shifted (e.g., changing primary should also update primary-hover and primary-light)

---

## Behavior: Import from Existing Config

### From Tailwind (`tailwind.config.js` / `tailwind.config.ts`)
1. Read the theme/extend section
2. Map Tailwind values to token names
3. Identify the personality from the values (small radii + tight spacing = Professional, etc.)
4. Write tokens.md with the imported values

### From CSS Variables
1. Read the CSS file
2. Map `--color-*`, `--spacing-*` etc. to token names
3. Write tokens.md

---

## Design Principles for Token Selection

These are the rails a model should follow when making choices:

### Color
- **Tinted neutrals** always look better than pure gray. Mix 5-10% of your primary hue into your grays.
- **3 is enough for v1**: primary, a neutral scale, and semantic colors. Adding a secondary color is a v2 concern.
- **Light backgrounds**: Use very light tints of your primary for highlights/selections, not a separate color. This creates cohesion.
- **Dark text on light**: `#111827` (near-black with blue tint) is almost always better than pure `#000000`.

### Typography
- **One font family** for v1. Two fonts is a design decision that takes expertise. If unsure, use the system font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`. It's free, fast, and native-feeling.
- **Skip display/heading fonts** unless the vision specifically calls for personality in typography.
- **Size scale**: The jump between sizes should be noticeable. If `base` is 16px, `lg` should be 18-20px, not 17px.

### Spacing
- **4px or 8px base**: 4px for data-dense UIs (tables, dashboards). 8px for consumer/content UIs. Don't use both.
- **Consistent multiplier**: If your base is 4px, your scale should be 4, 8, 12, 16, 24, 32. Not 4, 8, 10, 16, 20, 32.

### Radius
- **Match the personality**, not trends. Rounded corners (12px+) feel friendly. Sharp corners (2-4px) feel professional. Mixing large and small radii in the same UI looks broken.
- **Rule of thumb**: Inner radius = outer radius - padding. If a card has `radius-lg` (8px) and `padding-4` (16px), elements inside should use `radius-sm` or `radius-md`.

### Shadows
- **Fewer is better**. Most UIs need exactly 2: a subtle one for cards at rest, and a larger one for elevated elements (modals, dropdowns).
- **Match shadow color to background warmth**. Warm backgrounds → `rgba(0,0,0,0.08)` (lighter). Cool backgrounds → `rgba(0,0,0,0.12)` (slightly heavier).

---

## Integration

- `/spec-first` references tokens in ASCII mockups
- `/design-component` documents which tokens components use
- `/spec-init` detects existing tokens in codebase
- `/vision` establishes the personality that drives token choices
