---
description: Generate specs and tests from existing code (reverse TDD — document, don't fix)
---

Document existing code: $ARGUMENTS

## Philosophy

**Document, don't fix.** Capture what the code actually does. Don't modify source files.

## Flow

```
CODE → SPEC → TEST (all passing)
```

## When to Use

- Code written without specs (prototyping, legacy)
- Quick iteration skipped documentation
- After `/prototype` when you want to document without full formalization
- Called by `doc-loop-local.sh` in batch mode

## Steps

1. **Read the Code**: Analyze the component/module. Understand what it DOES, not what it SHOULD do.

2. **Generate Feature Spec**: Create Gherkin scenarios describing ACTUAL current behavior. Flag behaviors that seem unintentional under "Potential Issues".

3. **Write Passing Tests**: Tests that PASS against current implementation. Cover all identified behaviors.
   - If tests fail: re-read code and fix the TEST (not the source)
   - If still failing after one retry: log as "discovered behavior gap", move on

4. **Update Documentation**: Create/update test suite docs, run `./scripts/generate-mapping.sh`.

## Key Difference from /spec-first

| Aspect | /spec-first | /document-code |
|--------|-------------|----------------|
| Tests | Written to fail first | Written to pass |
| Spec | Defines desired behavior | Documents actual behavior |
| Use | New features | Existing code |

## Modes

### Single Component
Documents one component/module with full detail.

### Batch Mode (for doc-loop-local.sh)
When given multiple related files (a domain group), read ALL files together for cross-file context. Create one or more specs depending on how behaviors group.

## Rules

- **No code changes**: Do NOT modify source files. Only create .specs/ and test files.
- **Be honest**: Document what code does, even if it seems wrong
- **Flag issues**: Note potential bugs, don't fix them
- **One retry max**: If tests still fail after re-reading, log and move on

## Output Signals (for automation)

```
DOC_COMPLETE: {item number}
DOC_PARTIAL: {item number} — {reason}
DOC_FAILED: {item number} — {reason}
```

## Output

- Behaviors documented with test IDs
- Files created/updated
- Potential issues found (unintentional behaviors)
- Discovered behavior gaps (couldn't fully test)
- Suggested follow-ups
