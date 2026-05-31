# Security Policy

## Supported Versions

Bastra.Recall is pre-1.0. Security fixes target the latest public release and
`main`. Older beta releases may receive fixes only when the patch is small and
low-risk.

## Reporting A Vulnerability

Please do not open a public issue for suspected vulnerabilities.

Report privately through GitHub Security Advisories:

https://github.com/n0mad-ai/bastra-recall/security/advisories/new

Include:

- affected version or commit
- operating system and install method
- clear reproduction steps
- expected impact
- whether the issue requires local access, vault access, or a remote tunnel

You should receive an initial response within 7 days. If the report is valid,
the fix will be coordinated privately first and disclosed after a patched
release is available.

## Scope

In scope:

- unauthorized access to private memories or documents
- token/auth bypass in REST endpoints
- unsafe file writes outside the configured vault
- installer or update paths that execute unintended code
- dependency or release-chain compromise affecting published packages

Out of scope:

- memories intentionally saved by a local AI client with access to the vault
- local users reading files they already have filesystem permission to read
- social engineering or phishing
- denial of service against a local-only daemon unless it causes data loss

