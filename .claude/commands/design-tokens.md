---
description: Create or update personality-driven design tokens
---

Manage design tokens: $ARGUMENTS

## Actions

### `init` or no args — Create tailored tokens

**Do NOT stamp a generic template.** Derive tokens from context.

1. **Read context**: `.specs/vision.md` (app purpose, design principles), `.specs/personas/*.md` (patience, technical level), existing CSS/theme files. If nothing exists, ask: What kind of app? What vibe? Brand color?

2. **Determine personality** based on context:

| Personality | Radii | Spacing | Palette | Example Apps |
|-------------|-------|---------|---------|-------------|
| **Professional** | 2-6px | Tight (4px base) | Muted, high-contrast neutrals | Linear, Jira |
| **Friendly** | 8-12px | Comfortable (8px base) | Warm, 2-3 accents | Notion, Slack |
| **Minimal** | 4-8px | Generous whitespace | Near-monochrome | iA Writer, Apple |
| **Bold** | 12-16px+ | Generous | Vivid, high saturation | Stripe, Vercel |
| **Technical** | 0-4px | Tight-compact | Cool neutrals, functional only | GitHub, Grafana |

3. **Build palette from one color**:
   - Primary: from brand or personality default
   - `primary-hover`: 10% darker, `primary-light`: 90% lighter
   - Neutrals: tint grays with primary hue (pure gray looks dead)
   - Semantic (success/warning/error): match saturation to overall palette
   - Check: text on background ≥ 4.5:1 contrast

4. **Constrain to v1 minimums**:
   - Colors: primary + hover + light, 3-4 neutrals, 3 semantic
   - Typography: 1 font family, 4-5 sizes, 3 weights
   - Spacing: 6 values on consistent multiplier
   - Radii: 3 + full
   - Shadows: 2 (resting + elevated)

5. **Write** `.specs/design-system/tokens.md` with personality, rationale, and "What's Intentionally Missing"
6. **Create** `.cursor/rules/design-tokens.mdc` cursor rule

### `update {token} to {value}` — Update specific token

Update token value. If changing primary, also update primary-hover and primary-light. Check contrast still passes.

### `import from {file}` — Import from existing config

Extract from `tailwind.config.js` or CSS variables file. Identify personality from the values. Write tokens.md.

## Design Principles (Rails for Dumber Models)

- **Tinted neutrals** over pure gray. Mix 5-10% of primary hue into grays.
- **One font family** for v1. System stack if unsure.
- **4px base** for data-dense UIs, **8px base** for consumer UIs.
- **Radii match personality.** Don't mix large and small in the same UI.
- **Two shadows** is enough. One for cards, one for modals.
- **Fewer tokens = better system.** 5 spacing values used consistently beats 12 used randomly.

## Output

After changes, show:
- Personality chosen and why
- Primary color and derivation source
- Token counts by category
- What's intentionally deferred
- Files created/updated
