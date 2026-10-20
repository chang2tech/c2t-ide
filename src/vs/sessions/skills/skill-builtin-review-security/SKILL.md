---
name: skill-builtin-review-security
description: Security Review — runs a per-PR security review scan for exploitable issues. Use when the user types /review-security or asks for a security-focused review of a pull request or change (injection, auth, secrets, unsafe deserialization, etc.).
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Security Review

Run a Security Review scan against a pull request or change: a per-PR exploit-focused scan that flags security issues and unsafe patterns.

## When to Use

- The user types `/review-security` or asks for a security review of a PR, diff, or change.
- The user wants an exploit-oriented pass: injection, broken auth/access control, leaked secrets, unsafe deserialization, SSRF, and other security-relevant findings.

## Workflow

### 1. Determine the scan target

Use the pull request or diff the user indicated. If no target is clear, ask — a security review needs a bounded change set to be useful.

### 2. Run the security review

Run the Security Review scan on the target. It looks for exploitable issues, not style: entry points reachable with attacker-controlled input, missing authorization checks, credentials or secrets in code, unsafe dynamic evaluation, and insecure defaults.

### 3. Report findings

Present each finding with:

- **Severity** — critical/high/medium with a concrete exploit path, not just "this could be bad".
- **Location** — `file.ts:line` where the vulnerable pattern sits.
- **Suggested fix** — the minimal safe change.

Separate confirmed exploitable issues from hardening suggestions. If nothing exploitable is found, say so explicitly.

## Guidelines

- Never run exploit code against production systems or third-party services — findings are demonstrated by reading code, not by attacking it.
- Review-only: do not change the scanned code while reviewing; proposed fixes go in the report.
- Do not paste secrets found in the code into chat output — redact them and point at the location.
