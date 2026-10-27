# Reviewer checklist (N+1)

The reviewer completes this checklist before approving. The reviewer must not be the PR author.

**How to fill it in**

- Tick every item that applies. If an item does not apply, replace the box with `N/A: <reason>`.
- Cite item IDs (for example `AC-3`) in review comments and N/A notes.
- CodeRabbit, Minmax/kudos and SonarCloud findings are supporting evidence only. They don't replace this review. This checklist covers what those tools can't judge: intent, authorization, tenancy, and design.

---

## 1. Review gate

- [ ] **RG-1** I am not the author, and before approving I ran the change or read its tests.
- [ ] **RG-2** If this PR was merged with an admin bypass because no second reviewer was available, the reason is written below, and a reviewer completes this checklist after the merge.

## 2. Scope and risk

- [ ] **SR-1** If the change touches auth, crypto, RLS or migrations, infrastructure or deployment pipelines, or AI/ML models and data handling, I reviewed it more deeply against the threat model.
- [ ] **SR-2** Nothing removed was needed for security: validation, logging or auditing, access control, or a quality gate.
- [ ] **SR-3** No intentional or accidental bypass exists. Examples: a debug route, a test-only shortcut, a flag or env var that skips a check, or a commented-out guard.

## 3. Access control and tenancy

- [ ] **AC-1** Every new or changed route uses `GuardedRouter::requires`. A route that uses `public` states why.
- [ ] **AC-2** Every use case calls `PolicyEnforcer::assert_can`. Permissions are allowlists with least privilege.
- [ ] **AC-3** The tenant comes only from the verified internal JWT. It never comes from a URL, header, body or unsigned payload.
- [ ] **AC-4** Every new tenant table has RLS policies and pgTAP fixtures.
- [ ] **AC-5** Access is denied by default. A new permission, flag or config value defaults to the restrictive option.

## 4. Input validation

- [ ] **IV-1** All input that crosses a trust boundary is strictly validated: Zod schemas in web, typed request DTOs in Rust.
- [ ] **IV-2** Lengths and ranges are checked explicitly.
- [ ] **IV-3** A validation failure returns an error with an `ApiError` code. It never falls back to a silent default.

## 5. Safe execution and queries

- [ ] **SE-1** No unsafe execution: no `eval`, `new Function`, shell strings, unescaped HTML (`dangerouslySetInnerHTML`), Rust `unsafe`, or `std::process::Command` built from input.
- [ ] **SE-2** No SQL is built from runtime strings. Only `sqlx::query!` macros or literal queries are used.

## 6. Error handling and resources

- [ ] **EH-1** Errors are propagated with `Result` and `?`, not only logged. No `unwrap`, `expect` or `panic!` outside tests.
- [ ] **EH-2** Error responses and logs expose no sensitive data: no stack traces, secrets, SQL or upstream response bodies.
- [ ] **EH-3** Resources are released on error paths: transactions roll back, and files and connections close.
- [ ] **EH-4** Variables are initialized before use, kept to the smallest scope, and not reused for a different purpose.

## 7. Sensitive data, secrets and cryptography

- [ ] **SD-1** No PII or other sensitive data is logged, put in job payloads, or put in URLs.
- [ ] **SD-2** No hardcoded secrets: keys, passwords, tokens, internal IPs, account IDs or ARNs.
- [ ] **SD-3** Only modern, vetted cryptography is used (for example the CNSA Suite 2.0 algorithms).
- [ ] **SD-4** Encrypted data is authenticated before it is decrypted (AEAD, or verify-then-decrypt).
- [ ] **SD-5** Randomness is cryptographically secure where it matters: `crypto.randomUUID` or `getRandomValues` in TypeScript, `OsRng` or `uuidv7()` in Rust and SQL. Never `Math.random`.

## 8. Concurrency and resource limits

- [ ] **CR-1** There are no TOCTOU races. A check and its write happen in the same transaction or under a row lock.
- [ ] **CR-2** Shared resources are protected against DoS and abuse with timeouts, pagination limits and rate limits.

## 9. Dependencies and static analysis

- [ ] **DP-1** No dependency with a known vulnerability was added, and I reviewed every dependency bump.
- [ ] **DP-2** SCA is clean. SonarCloud, `pnpm audit`, `cargo deny` and `trivy fs` (on both lockfiles) report no unresolved critical or high findings.
- [ ] **DP-3** The accepted-advisories check passes, and every exception is current and justified.

---

**Admin bypass reason (RG-2 only):**

<!-- Why no second reviewer was available, and who completes this checklist after the merge. -->
