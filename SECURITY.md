# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |

## Local-First Privacy Guarantees

FastTyper is designed with privacy as a foundational principle:
- All language model inference runs strictly locally via `127.0.0.1` (`localhost`).
- Keystrokes, text inputs, and note contents are never transmitted across the public internet.
- Debug logs (e.g. `trigger-debug.log`, `llm-log.txt`) are excluded from version control to prevent accidental data leakage.

## Reporting a Vulnerability

If you discover a security vulnerability or sensitive data leak in FastTyper:
1. Please do not open a public issue.
2. Report the vulnerability privately via GitHub Security Advisories or email the maintainers directly.
3. We will acknowledge receipt within 48 hours and work with you on a coordinated disclosure schedule.
