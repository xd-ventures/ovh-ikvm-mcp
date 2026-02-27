# Contributing to ovh-ikvm-mcp

Thank you for your interest in contributing! This guide will help you get
started.

## Prerequisites

- [Bun](https://bun.sh/) v1.1+
- [Git](https://git-scm.com/)
- [GitHub CLI](https://cli.github.com/) (`gh`)

## Development Setup

```bash
git clone https://github.com/xd-ventures/ovh-ikvm-mcp.git
cd ovh-ikvm-mcp
bun install
```

Verify everything works:

```bash
bun run typecheck && bun run lint && bun test
```

## Development Workflow

We use a **BDD (Behavior-Driven Development)** approach:

1. **Write a failing test** that describes the desired behavior
2. **Implement** the minimum code to make the test pass
3. **Refactor** while keeping tests green
4. **Repeat** for the next behavior

### Branch Naming

Create a branch from `main` using one of these prefixes:

- `feat/<name>` — new features
- `fix/<name>` — bug fixes
- `test/<name>` — test improvements
- `docs/<name>` — documentation changes
- `chore/<name>` — maintenance tasks

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature
- `fix:` — bug fix
- `test:` — test changes
- `docs:` — documentation
- `chore:` — maintenance

### Submitting a Pull Request

1. Create your feature branch:
   ```bash
   git checkout main && git pull
   git checkout -b feat/my-feature
   ```

2. Make your changes following the BDD workflow.

3. Verify all checks pass:
   ```bash
   bun run typecheck && bun run lint && bun test
   ```

4. Push and open a PR:
   ```bash
   git push -u origin feat/my-feature
   gh pr create --title "feat: my feature" --body "Description of changes"
   ```

5. Address any review feedback and push updates.

## Useful Commands

| Command              | Description                    |
|----------------------|--------------------------------|
| `bun test`           | Run all tests                  |
| `bun test --watch`   | Run tests in watch mode        |
| `bun run typecheck`  | TypeScript type checking       |
| `bun run lint`       | Lint with Biome                |
| `bun run lint:fix`   | Lint and auto-fix              |
| `bun run dev`        | Run server with watch mode     |

## Code Style

- **TypeScript strict mode** — no `any` unless absolutely necessary
- **Explicit return types** on exported functions
- **`interface` over `type`** for object shapes
- **`unknown` over `any`** for untyped external data
- Formatting and linting are handled by [Biome](https://biomejs.dev/)

## Reporting Issues

- **Bugs**: Open a [GitHub issue](https://github.com/xd-ventures/ovh-ikvm-mcp/issues)
- **Security vulnerabilities**: See [SECURITY.md](SECURITY.md)

## Code of Conduct

This project follows the [Contributor Covenant 3.0](CODE_OF_CONDUCT.md).
All participants are expected to uphold this code.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE).
