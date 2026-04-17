# Testing Learnings

Patterns for testing in this codebase.

---

## Mocking

<!-- Patterns for mocking dependencies, APIs, etc. -->

_No learnings yet._

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

<!-- Common edge cases to always test -->

_No learnings yet._
