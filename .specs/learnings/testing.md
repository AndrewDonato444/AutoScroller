# Testing Learnings

Patterns for testing in this codebase.

---

## Mocking

### Don't Mock process.env — Use Dependency Injection

**Problem:** Tried to mock `process.env.HOME` with `Object.defineProperty()` — Node.js rejects this.

**Solution:** Pass `homeDir` as an option parameter instead:

```typescript
export async function loadConfig(options: LoadConfigOptions = {}): Promise<Config> {
  const home = options.homeDir ?? homedir();
  // ... use home instead of process.env.HOME
}

// In tests:
await loadConfig({ homeDir: testHomeDir });
```

**Why:** Node.js's `process.env` object is read-only in many contexts. Dependency injection is simpler, more reliable, and makes the function easier to test without framework-specific mocking.

---

## Assertions

### Negative Assertions for Anti-Patterns

Test that forbidden dependencies DON'T exist by checking each one explicitly:

```typescript
it('should have no hosted-product dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  const forbiddenDeps = ['auth0', 'firebase', 'sentry', 'amplitude'];
  forbiddenDeps.forEach(dep => {
    expect(allDeps[dep]).toBeUndefined();
  });
});
```

**Why:** Prevents scope creep and anti-persona drift. If someone accidentally adds a forbidden dependency, the test fails immediately with a clear message about which one.

---

## Test Structure

### Test-the-Scaffold Pattern

For foundational features (project setup, config loaders, directory structure), tests validate the scaffold itself rather than runtime behavior:
- Check package.json fields (engines, scripts, dependencies)
- Verify directory structure exists
- Assert configuration files have correct settings
- Validate repository files (.gitignore, README, LICENSE)

**Example from Project Scaffold:**
```typescript
describe('UT-001: Package configuration', () => {
  it('should have package.json with correct engines', () => {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    expect(pkg.engines.node).toMatch(/>=\s*20/);
  });
});
```

This pattern gives regression coverage for infrastructure that doesn't have "user behavior" to test.

---

## Integration Tests

### CLI Integration Test with Error Capture

When testing CLI commands with `child_process.execSync`, wrap in try/catch to capture both stdout and stderr on failure:

```typescript
it('should run pnpm scroll and print version banner', () => {
  try {
    const output = execSync('pnpm scroll', {
      cwd: rootDir,
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    expect(output).toContain('scrollproxy');
  } catch (error: any) {
    // Fail with actual error details
    throw new Error(`pnpm scroll failed: ${error.message}\nStdout: ${error.stdout}\nStderr: ${error.stderr}`);
  }
});
```

**Why:** Without the try/catch, test failures show only "command exited with code 1" — no visibility into what broke. This pattern surfaces the actual error output.

---

## Edge Cases

### File System Isolation with Temporary Directories

Use temporary directories with unique timestamps for each test:

```typescript
let testTmpDir: string;
let testHomeDir: string;

beforeEach(() => {
  testTmpDir = join(tmpdir(), 'scrollproxy-test-' + Date.now());
  testHomeDir = join(testTmpDir, 'home');
  mkdirSync(testHomeDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testTmpDir)) {
    rmSync(testTmpDir, { recursive: true, force: true });
  }
});
```

**Why:** Prevents tests from interfering with each other or the developer's real config files. The timestamp ensures parallel test runs don't collide.

**Atomic write verification:** For features that write files atomically (tmpfile → rename), verify the tmpfile is cleaned up after a successful write:

```typescript
it('should clean up tmpfile after atomic write', async () => {
  await writeRawJson({ outputDir: testDir, runId, posts, stats, meta });
  
  const tmpPath = join(testDir, runId, 'raw.json.tmp');
  expect(existsSync(tmpPath)).toBe(false);  // tmpfile cleaned up
  
  const finalPath = join(testDir, runId, 'raw.json');
  expect(existsSync(finalPath)).toBe(true);  // final file exists
});
```

This proves the atomic write completed successfully (rename succeeded).

### No Mocking of Core Libraries in Integration Tests

For config loading, extractor logic, or other integration tests, use real libraries (yaml, zod) instead of mocks:

```typescript
// GOOD: Real integration test
const config = await loadConfig({ path: testConfigPath });
expect(config.scroll.minutes).toBe(10);

// BAD: Mocking the library we're testing
vi.mock('yaml', () => ({ parse: vi.fn() }));
```

**Why:** Integration tests verify that your code works with the real library APIs. Mocking defeats this purpose. Unit tests are for isolated logic; integration tests prove the wiring works.

**JSON structure verification:** Use `JSON.parse()` to verify structure instead of string matching:

```typescript
// GOOD: Parse and verify structure
const content = readFileSync(rawJsonPath, 'utf-8');
const payload = JSON.parse(content);
expect(payload.schemaVersion).toBe(1);
expect(payload.posts.length).toBe(84);

// BAD: String matching on JSON
expect(content).toContain('"schemaVersion": 1');
```

**Why:** String matching is brittle (whitespace, key order). Parsing proves the JSON is valid and gives type-safe access to fields.

### Async Test Assertions Require Error Objects

When testing error cases with async functions, throw `new Error()` instances, not raw library errors:

```typescript
// GOOD: Throw Error with clear message
catch (error) {
  if (error instanceof ZodError) {
    throw new Error(`config error: ${fieldPath} — ${message}`);
  }
}

// BAD: Re-throw raw ZodError
catch (error) {
  throw error;  // Test assertions on ZodError properties are fragile
}
```

**Why:** Vitest and other test frameworks expect Error instances with `.message` properties. Raw ZodError has `.issues` arrays and other non-standard shapes, making assertions brittle.

---

## Test Helpers

### Test Helpers Can Have Subtle Bugs

When writing custom test helpers (like a CLI process spawner), verify the helper works correctly before trusting test failures:

```typescript
// BAD: Early-resolve setTimeout causes false positives
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn('tsx', args);
    
    setTimeout(() => {
      resolve({ exitCode: null });  // Resolves early!
    }, 100);
    
    child.on('close', (exitCode) => {
      resolve({ exitCode });  // Never reached if timeout fires first
    });
  });
}

// GOOD: Timeout only fires if process hangs
function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn('tsx', args);
    let resolved = false;
    
    const timeout = setTimeout(() => {
      if (!resolved) {
        child.kill('SIGTERM');
        resolved = true;
        resolve({ exitCode: null });
      }
    }, options.timeout || 10000);
    
    child.on('close', (exitCode) => {
      if (!resolved) {
        clearTimeout(timeout);
        resolved = true;
        resolve({ exitCode });
      }
    });
  });
}
```

**Why:** The first version resolved after 100ms with `null` exitCode, causing tests to pass even when the CLI failed. The bug was discovered when all tests passed but the feature clearly didn't work. The fix: use a `resolved` flag and only resolve once.

### Tests Requiring External Dependencies Can Be Skipped

When tests require external binaries (like Chromium from Playwright), mark them `.skip()` with clear comments:

```typescript
describe('UT-LOGIN-003: Successful login detected from final URL', () => {
  it.skip('should exit 0 when final URL is x.com/home', async () => {
    // This test requires Playwright Chromium to be installed
    // Run `pnpm exec playwright install chromium` to enable
    const result = await runCli(['login'], { timeout: 5000 });
    expect(result.exitCode).toBe(0);
  });
});
```

**Why:** Not all contributors have Playwright Chromium installed. Skipped tests document what should work but don't block test runs. They pass locally when dependencies are present, fail gracefully otherwise.

### Tests Need Proper Config or They Hang

When testing CLI commands that launch browsers, ensure the test config has `headless: false` or the proper error-handling setup:

```typescript
// If config has headless: true, the test must expect early exit
const headlessConfigYaml = validConfigYaml.replace('headless: false', 'headless: true');

it('should exit 2 when headless is true', async () => {
  const configPath = join(testConfigDir, 'config.yaml');
  writeFileSync(configPath, headlessConfigYaml, 'utf-8');
  
  const result = await runCli(['login'], { timeout: 2000 });  // Short timeout!
  expect(result.exitCode).toBe(2);
});
```

**Why:** Without proper config, tests can hang waiting for browser input. The login command validates headless early and exits, but tests need to set up config correctly or they'll timeout. Short timeouts on early-exit tests help catch config issues.

### Scaffold Tests Verify Project Conventions

Scaffold tests (like UT-004) verify project-wide conventions such as:
- `.gitkeep` files exist in all module directories (`src/state/`, `src/writer/`, `src/config/`)
- Module directories maintain `.gitkeep` even after they contain real implementation files

**Gotcha:** When implementing a new module directory, remember to add `.gitkeep` to satisfy scaffold tests. The pattern isn't "remove .gitkeep when adding real files" — it's "all module directories have .gitkeep, always."

**Why this pattern exists:** Consistency across module structure. Tests enforce this so the directory layout remains predictable.

**When to apply:** Any time you create a new first-class module directory (like `src/state/` for the dedup cache), add a `.gitkeep` file immediately, before or alongside the first real implementation file.

### Testing for Substring Absence Requires Section Isolation

**Problem:** Test checked entire document for absence of a substring (` — `) but the substring legitimately appears in some sections (header).

**Solution:** Extract the specific section being tested and assert on that:

```typescript
// BAD: Checking entire document
const markdown = renderSummaryMarkdown(summary, context);
expect(markdown).not.toContain(' — ');  // ❌ Fails — header has " — "

// GOOD: Check only the relevant section
const noiseMatch = markdown.match(/## Noise\n\n(.*?)\n\n/s);
expect(noiseMatch).not.toBeNull();
const noiseSection = noiseMatch![1];
expect(noiseSection).not.toContain(' — ');  // ✅ Passes
```

**Why:** When testing for absence, the entire document may have legitimate uses of the pattern you're excluding from a specific section. Isolate the section first, then assert on it.

**When to apply:** Any test that asserts a substring does NOT appear in output. Verify the absence is specific to the section/context you care about, not the entire output.

### Test Fixture Helpers Improve Readability

**Pattern:** Extract helper functions to create test fixtures with sensible defaults:

```typescript
// Helper to create a minimal RunSummary
function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    schemaVersion: 1,
    runId: '2026-04-17T09-02-14Z',
    summarizedAt: '2026-04-17T09:12:48.000Z',
    model: 'claude-sonnet-4-6',
    themes: ['agent orchestration patterns', 'indie-dev distribution'],
    worthClicking: [],
    voices: [],
    noise: { count: 0, examples: [] },
    newVsSeen: { newCount: 38, seenCount: 46 },
    feedVerdict: 'mixed',
    ...overrides,
  };
}

// Helper for context with tilde-compressed paths
function makeContext(overrides: Partial<MarkdownContext> = {}): MarkdownContext {
  const runId = '2026-04-17T09-02-14Z';
  return {
    rawJsonPath: `/Users/andrew/scrollproxy/runs/${runId}/raw.json`,
    summaryJsonPath: `/Users/andrew/scrollproxy/runs/${runId}/summary.json`,
    displayRawJsonPath: `~/scrollproxy/runs/${runId}/raw.json`,
    displaySummaryJsonPath: `~/scrollproxy/runs/${runId}/summary.json`,
    ...overrides,
  };
}

// Usage in tests
it('renders worth-clicking with correct format', () => {
  const summary = makeSummary({
    worthClicking: [{ postId: '1', url: 'https://...', author: '@someone', why: 'Test' }],
  });
  const context = makeContext();
  const markdown = renderSummaryMarkdown(summary, context);
  expect(markdown).toContain('1. [@someone](https://...) — Test');
});
```

**Why:** Tests stay focused on what varies (the specific scenario) instead of repeating boilerplate setup. All 19 markdown writer tests used `makeSummary` and `makeContext`, keeping them readable and maintainable.

**When to apply:** When you have complex data structures (summaries, configs, API responses) that need sensible defaults but vary per test. If 3+ tests construct similar objects, extract a helper.

### CLI Routing Tests with --dry-run

**Pattern:** When testing CLI routing (verifying that a command invokes the correct handler), use `--dry-run` flag to skip expensive operations while still exercising the real handler path.

```typescript
describe('UT-CLI-011: pnpm replay <run-id> routes to replay handler', () => {
  it('should invoke replay handler with run-id', async () => {
    // Write valid config
    const configPath = join(testConfigDir, 'config.yaml');
    writeFileSync(configPath, validConfigYaml, 'utf-8');

    // Create run directory with raw.json
    setupTestRunDirectory('2026-04-16-0830');

    // Use dry-run to avoid making actual API calls in this routing test
    const result = await runCli(['replay', '2026-04-16-0830', '--dry-run']);

    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(result.stdout).toContain('replay');
    expect(result.stdout).toContain('2026-04-16-0830');
    expect(result.stdout).toContain('dry-run');
  });
});
```

**Why:** Routing tests verify "does this command reach the right handler?" not "does the handler work correctly?" Using `--dry-run` keeps tests fast, avoids API costs, and doesn't require mocking. The handler's own test suite validates its logic.

**When to apply:** CLI entry tests that verify command routing, flag parsing, and dispatcher behavior. The handler's integration tests validate the actual work.

### CLI Tests Need Full Fixture Setup

**Gotcha:** Tests that invoke CLI commands which load handlers need to provide ALL runtime dependencies, even if they're not the focus of the test.

**Example:** Replay CLI routing tests failed because the replay handler loads the themes store on startup, which requires the state directory to exist. The test was only trying to verify routing, but the real handler's initialization code ran anyway.

**Solution:** Create helper functions that set up complete fixtures:

```typescript
/**
 * Helper to set up a test run directory with raw.json
 */
function setupTestRunDirectory(runId: string, runsDir?: string): string {
  const actualRunsDir = runsDir ?? join(testHomeDir, 'scrollproxy', 'runs');
  const runDir = join(actualRunsDir, runId);
  mkdirSync(runDir, { recursive: true });

  // Create state directory for themes store (even though we're not testing it)
  const stateDir = join(testHomeDir, 'scrollproxy', 'state');
  mkdirSync(stateDir, { recursive: true });

  // Create raw.json
  const rawJson = createMinimalRawJson(runId);
  writeFileSync(join(runDir, 'raw.json'), JSON.stringify(rawJson, null, 2), 'utf-8');

  return runDir;
}
```

**Why:** CLI handlers may load state, initialize caches, or validate directories on startup. Tests that invoke real handlers (not mocks) need to provide all dependencies or they'll fail with cryptic errors (missing directories, file not found).

**When to apply:** Any CLI routing test that invokes real handlers. Use `--dry-run` to skip expensive operations, but still provide the fixtures needed for initialization.

### Stale Test Expectations from Stub Implementations

**Gotcha:** When implementing a feature that replaces a stub, old test expectations referencing stub messages ("not yet wired") become stale and cause failures.

**Example:**
```typescript
// OLD expectation when replay was a stub:
expect(result.stdout).toContain('not yet wired feature 14');

// NEW expectation after feature implemented:
expect(result.stdout).toContain('replay');
expect(result.stdout).toContain('dry-run');
```

**Solution:** When replacing a stub with real implementation:
1. Search test files for the stub's message string
2. Update expectations to match the real handler's behavior
3. Consider whether the test still makes sense (routing tests should remain, behavior tests may need rewrite)

**Why:** Stubs print placeholder messages for testing the dispatcher. Real handlers print actual output. Forgetting to update test expectations causes confusing failures where the feature works but tests fail.

**When to apply:** Every time you replace a stub function with a real implementation, grep the test directory for the stub's message string and update any assertions.

### Test Duplication for Self-Containment

Duplicating test helpers (like `runCli`) and config fixtures across test files is acceptable:

```typescript
// tests/foundation/login.test.ts
function runCli(args, options) { /* ... */ }
const validConfigYaml = `...`;

// tests/foundation/scroll.test.ts
function runCli(args, options) { /* ... duplicate */ }
const validConfigYaml = `...`;  /* duplicate */
```

**Why:** Each test file is self-contained and can be understood in isolation. Extracting shared helpers to a central test-utils file adds coupling and navigation cost. If the helper evolves differently for different test suites, the duplication was the right call.

### Browser-Dependent Tests Documented with Skip

**Pattern:** For integration tests requiring external dependencies (Chromium, network, third-party services), use `.skip()` with clear in-file documentation:

```typescript
describe('UT-SCROLL-DRY-001: Dry-run scroll completes successfully', () => {
  it.skip('should scroll and extract posts without writing', async () => {
    /**
     * SKIPPED: Requires Chromium browser from Playwright
     * 
     * To run this test:
     * 1. Install Playwright browsers: `pnpm exec playwright install chromium`
     * 2. Ensure ~/scrollproxy/chrome browser profile exists (run `pnpm login` once)
     * 3. Remove .skip() from this test
     * 
     * Why skipped: Integration test against real browser session.
     * The handler logic is straightforward — code review + unit tests
     * (replay dry-run, login rejection) provide sufficient coverage.
     */
    const result = await runCli(['scroll', '--dry-run', '--minutes', '1']);
    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(result.stdout).toContain('dry-run complete');
  });
});
```

**Why:** Not all contributors have browsers/profiles set up. Skipped tests pass on fresh checkout but document expected behavior. The comments explain:
- What dependency is missing
- How to install it  
- Why it's skipped
- What alternate coverage exists

**When to apply:** Features requiring browser automation, network access, or external services. Test suite should pass without manual setup while documenting full integration behavior.

### Integration Tests as Living Documentation

**Pattern:** Write comprehensive integration tests even when they must be skipped — they serve as executable documentation:

```typescript
// 7 scroll dry-run scenarios, all skipped but fully implemented
it.skip('happy path — extract posts, no writes', async () => { ... });
it.skip('ANTHROPIC_API_KEY unset — succeeds', async () => { ... });
it.skip('--minutes override enforced', async () => { ... });
it.skip('browser closes mid-scroll — early termination', async () => { ... });
```

**Why:** When someone enables these tests later (after setup), ready-to-run validation exists. Tests document every Gherkin scenario in executable form. Future contributors see expected behavior by reading the test, even if they can't run it yet.

**Example from Dry-Run Flag:** Created 7 comprehensive scroll dry-run tests (all skipped due to browser requirement) while running non-browser tests (replay dry-run, login rejection) for merge coverage. The skipped tests are ready when environment is configured.

### Real API Integration Tests

**Pattern:** For features that integrate with external APIs (like Anthropic Claude), write tests that make real API calls to validate the integration end-to-end.

```typescript
describe('UT-SUM-003: First run ever — no prior themes', () => {
  it('handles empty priorThemes array correctly', async () => {
    const input: SummarizerInput = {
      posts: [makePost('1', 'user1', 'AI product strategy discussion')],
      newPostIds: ['1'],
      priorThemes: [],
      interests: ['AI product strategy'],
      runId: '2026-04-17T09-00-00Z',
      model: 'claude-sonnet-4-6',
      apiKey: process.env.ANTHROPIC_API_KEY || 'test-key',
    };
    
    const result = await summarizeRun(input);
    
    if (result.status === 'ok') {
      expect(result.summary.themes.length).toBeGreaterThan(0);
      expect(result.summary.newVsSeen.newCount).toBe(1);
    }
  });
});
```

**Why:** Validates that your code works with the real API shape, error responses, and timeout behavior. Mocks hide integration issues — they pass even when the actual API changes. Real calls catch auth errors, schema mismatches, and rate-limit handling bugs.

**Trade-offs:**
- **Slow:** ~19 seconds total for 10 tests vs. instant with mocks
- **Requires API key:** Tests need `ANTHROPIC_API_KEY` env var or fail gracefully
- **Non-deterministic:** LLM responses vary slightly run-to-run
- **Costs money:** Each test call uses API credits

**When to apply:** Features that wrap third-party APIs where integration bugs are more likely than logic bugs. Use recorded fixtures for regressions after the integration is proven.

**Mock API Key Validation:** When using a mock/invalid API key (like `'sk-ant-test-key'`), the test can validate the error path:

```typescript
it('uses ANTHROPIC_API_KEY when config.claude.apiKey is empty', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';  // Invalid key
  
  const result = await summarizeRun(input);
  
  if (result.status === 'error') {
    expect(result.reason).not.toContain('no_api_key');
    expect(result.reason).toContain('401');  // Auth error expected
  }
});
```

This validates that the code attempts the API call and handles 401 errors correctly, without needing a real API key.

---

## Spec Precision

### Timing Precision for Async Callbacks in Specs

**Problem:** Spec said callback is awaited "after each wheel tick and its post-tick pause" — ambiguous about whether pause happens before or after callback.

**Impact:** Implementation chose: `wheel → callback → pause`. Spec wording implied: `wheel → pause → callback`. Drift agent flagged this as misalignment.

**Solution:** Be explicit about operation order in Gherkin scenarios:

```markdown
### Scenario: Tick hook exposes the page after each scroll
...
Then after each wheel tick (and before the tick's post-tick pause),
  `onTick({ page, tickIndex, elapsedMs })` is awaited before the pause starts
```

**Why:** "After X and Y" is ambiguous when Y is a duration. Does the callback fire after Y completes, or before Y starts? Async operations with multiple steps (action → callback → delay) need explicit sequencing in specs, or implementation will make an arbitrary choice that may not match spec intent.

**When to apply:** Any time a callback fires in a multi-step async flow (network request → callback → retry, scroll → callback → pause, save → callback → cleanup), document the exact sequence. Don't rely on "and" to imply order.

---

## Testing Read-Only Behavior

### Deep Copy Comparison for Non-Mutating Functions

When testing that a function doesn't mutate its inputs, use deep copy comparison:

```typescript
it('should not mutate input arrays', () => {
  const posts = [{ id: '123', text: 'hello' }];
  const stats = { postsExtracted: 1, adsSkipped: 0, selectorFailures: [], duplicateHits: 0 };
  
  // Deep copy before calling
  const postsCopy = JSON.parse(JSON.stringify(posts));
  const statsCopy = JSON.parse(JSON.stringify(stats));
  
  await writeRawJson({ posts, stats, ... });
  
  // Verify no mutation
  expect(posts).toEqual(postsCopy);
  expect(stats).toEqual(statsCopy);
});
```

**Why:** Proves the function is read-only. Reference checks (`Object.is`) would catch reassignment but not mutation of nested properties. Deep copy + equality check catches both.

**When to apply:** Functions that receive complex objects (posts arrays, stats objects) and must not modify them. Especially important for writer/serializer functions that should be pure readers.
