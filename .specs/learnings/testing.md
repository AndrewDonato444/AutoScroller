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
