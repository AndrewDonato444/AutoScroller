# API & Data Learnings

Patterns for API and data handling in this codebase.

---

## LLM API Patterns

### Anthropic SDK Tool-Use for Structured Output

**Pattern:** Use the Anthropic SDK's tool-use feature to get structured JSON output instead of parsing free-form text.

```typescript
const RETURN_SUMMARY_TOOL: Anthropic.Tool = {
  name: 'return_summary',
  description: 'Return the structured summary of the feed',
  input_schema: {
    type: 'object',
    properties: {
      themes: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 7 },
      worthClicking: { type: 'array', items: { ... }, maxItems: 10 },
      // ... full schema
    },
    required: ['themes', 'worthClicking', 'voices', 'noise', 'feedVerdict'],
  },
};

const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  tools: [RETURN_SUMMARY_TOOL],
  messages: [{ role: 'user', content: prompt }],
});

// Find tool use block and extract typed input
const toolUse = response.content.find(
  (block): block is Anthropic.ToolUseBlock => 
    block.type === 'tool_use' && block.name === 'return_summary'
);

if (!toolUse) {
  return { status: 'error', reason: 'malformed_response', rawResponse: JSON.stringify(response.content) };
}

const data = toolUse.input as ClaudeToolInput;  // Typed!
```

**Why:** More reliable than asking Claude to return JSON and parsing the response text. The SDK validates against the schema and returns structured data. If Claude doesn't use the tool or returns malformed input, you get a clear failure mode.

**When to apply:** Any Claude API call where you need structured output (summaries, classifications, extractions). Especially valuable when the output has required fields and constraints (min/max array lengths, enum values).

### AbortController for API Timeouts

**Pattern:** Use AbortController to enforce bounded wait times on SDK calls.

```typescript
const abortController = new AbortController();
const timeoutId = setTimeout(() => abortController.abort(), 60_000);

try {
  const response = await client.messages.create(
    { model, max_tokens, tools, messages },
    { signal: abortController.signal }
  );
  // ... process response
} catch (error: any) {
  if (error.name === 'AbortError') {
    return { status: 'error', reason: 'timeout' };
  }
  // ... other error handling
} finally {
  clearTimeout(timeoutId);
}
```

**Why:** Prevents hanging on slow API responses. The `signal` parameter is passed to the SDK's underlying fetch call. On timeout, the request is aborted and you get an `AbortError` with `error.name === 'AbortError'`.

**When to apply:** Any long-running API call that must not hang indefinitely. Essential for CLI tools where the operator has "very low patience for daily use."

### Single-Retry Strategy for LLM APIs

**Pattern:** Retry once for transient failures (429, 5xx, network errors), fail immediately for non-transient (401, 400, malformed response).

```typescript
async function callClaudeWithRetry(client, model, prompt, signal) {
  const result = await callClaude(client, model, prompt, signal);
  
  if (result.success) {
    return result;
  }
  
  // Check if error is transient
  const isTransient = 
    result.reason === 'rate_limited' || 
    result.reason.includes('api_unavailable');
  
  if (!isTransient) {
    return result;  // Fail fast for 401, 400, malformed_response
  }
  
  // Wait 2 seconds and retry once
  await new Promise(resolve => setTimeout(resolve, 2000));
  return callClaude(client, model, prompt, signal);
}
```

**Why:** One retry catches common transient bumps (brief rate limits, temporary 5xx). Multiple retries turn a bad API day into a multi-minute hang. Non-transient errors (bad auth, malformed request) won't be fixed by retrying.

**Simplified retry classifier:** Using a single substring check (`api_unavailable`) keeps the logic simple. All HTTP failures get the `api_unavailable:` prefix, so they're retried once. This means 401 and 400 get one wasted retry, but the total wait is still bounded by the timeout, and the simplicity avoids complex error categorization.

**When to apply:** Any API call to a rate-limited or occasionally-unreliable service. Balance between resilience (catch transient failures) and responsiveness (don't hang on persistent errors).

### Error Status Code Handling with Anthropic SDK

**Pattern:** Check `error.status` for HTTP status codes, `error.name` for AbortError, and handle each category appropriately.

```typescript
catch (error: any) {
  if (error.name === 'AbortError') {
    return { success: false, reason: 'timeout' };
  }
  
  if (error.status === 401) {
    return { success: false, reason: 'api_unavailable: 401 unauthorized' };
  }
  
  if (error.status === 400) {
    return { success: false, reason: 'api_unavailable: 400 bad request', rawResponse: error.message };
  }
  
  if (error.status === 429) {
    return { success: false, reason: 'rate_limited' };
  }
  
  if (error.status && error.status >= 500) {
    return { success: false, reason: `api_unavailable: ${error.status}` };
  }
  
  // Network error or unknown
  return { success: false, reason: `api_unavailable: ${error.message}` };
}
```

**Why:** Anthropic SDK surfaces HTTP errors with `.status` property and network errors with `.message`. AbortController abort produces `AbortError` with `.name`. Categorizing by error type enables appropriate retry logic and user-facing error messages.

**When to apply:** Any SDK call where you need typed error results instead of letting exceptions bubble up.

---

## Endpoints

<!-- API structure, naming conventions, versioning -->

_No learnings yet._

---

## Data Shapes

### Payload Optimization for LLM APIs

**Pattern:** Cap array size and flatten nested structures before sending to LLM APIs.

```typescript
// Cap at 200 posts (most recent first)
const sorted = [...posts].sort((a, b) => b.tickIndex - a.tickIndex);
const capped = sorted.slice(0, 200);

// Flatten quoted chains to one level
const compactPosts = capped.map(post => ({
  ...post,
  quoted: post.quoted ? { ...post.quoted, quoted: null } : null,
}));
```

**Why:** LLM APIs have token budget limits. Sending 350 posts costs more and may hit rate limits. Capping at 200 keeps the call under budget for a 10-minute scroll. Flattening nested structures (quoted.quoted chains) reduces payload size for marginal signal loss.

**Trade-off:** The operator's counts (newVsSeen) reflect ALL posts, not just the 200 sent to Claude. This is correct — the cap is for Claude's input, not for the operator's understanding.

**When to apply:** Any feature that sends large arrays to LLM APIs. Empirically tune the cap (200 posts worked for this project's feed density).

### Schema Version Validation with Clear Error Messages

**Pattern:** When reading versioned data, validate the schema version and throw a clear error for unsupported versions instead of attempting partial renders.

```typescript
// Schema version this renderer supports
const SUPPORTED_SCHEMA_VERSION = 1;

export function renderSummaryMarkdown(summary: RunSummary, context: MarkdownContext): string {
  // Validate schemaVersion first
  if (summary.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `markdown_writer: unsupported schemaVersion ${summary.schemaVersion}, expected ${SUPPORTED_SCHEMA_VERSION}`
    );
  }
  
  // Proceed with rendering...
}
```

**Why:** 
1. **Fail loudly** — Operator sees exactly which version is unsupported, not a cryptic field access error
2. **No silent corruption** — Better to not render at all than render garbage from mismatched schemas
3. **Clear upgrade path** — Error message tells operator what version the tool expects
4. **Prevents partial renders** — Don't render half a v2 summary using v1 template

**When to apply:** Any function that reads versioned data (summaries, state files, config) and needs to handle schema evolution. Add the check at the entry point before accessing any fields.

**Handling version mismatches:**
- Version too old → Clear error suggesting upgrade or re-run
- Version too new → Clear error suggesting binary rollback or re-summarize
- If partial compatibility is possible → Fork the rendering logic, don't try/catch field access

### Schema Versioning in JSON Output

**Pattern:** Include a `schemaVersion` field in all JSON outputs to enable future compatibility.

```typescript
export interface RunSummary {
  schemaVersion: 1;  // Incremented when structure changes
  runId: string;
  // ... rest of fields
}
```

**Why:** When the summary structure evolves (e.g., adding a `modelParams` field in v2), readers can check `schemaVersion` and handle old vs new formats appropriately. Essential for tools that read saved files from prior runs.

**When to apply:** Any JSON file that gets written to disk and read later (`summary.json`, `raw.json`, state files). Add the version field from v1, don't wait until breaking changes force it.

---

## Fetching Patterns

<!-- How to call APIs, retry logic, loading states -->

_No learnings yet._

---

## Caching & State

<!-- Server state, client state, sync patterns -->

_No learnings yet._
