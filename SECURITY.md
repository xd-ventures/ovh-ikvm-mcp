# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it
responsibly using one of the following methods:

1. **GitHub Security Advisories** (preferred):
   [Open a new advisory](https://github.com/xd-ventures/ovh-ikvm-mcp/security/advisories/new)

2. **Email**: Contact the maintainers at the email address listed on their
   GitHub profiles.

Please **do not** open a public issue for security vulnerabilities.

## What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: Within 48 hours of receiving the report
- **Initial assessment**: Within 7 days
- **Fix or mitigation**: Depends on severity, but we aim to address critical
  issues as quickly as possible

## Scope

The following are in scope for security reports:

- BMC session handling and credential management
- WebSocket connections to BMC endpoints
- MCP server input validation
- Dependency vulnerabilities

The following are **out of scope**:

- Vulnerabilities in the BMC firmware itself (report those to the hardware vendor)
- Issues requiring physical access to the server
