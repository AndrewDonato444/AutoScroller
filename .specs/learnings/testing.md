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
