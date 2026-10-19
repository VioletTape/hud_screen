# Repository Guidelines

## Project Structure

- `src/server/` contains the Express server, system utilities, and integrations in `providers/`.
- `src/shared/types.ts` holds shared TypeScript types.
- `src/client/` contains the HUD and settings pages, styles, and browser code.
- `config/config.json` stores runtime settings. `scripts/` contains Windows launch helpers; `scratch/` holds local experiments and previews.

## Build, Test, and Development

- `npm install` installs dependencies.
- `npm run dev` starts the server with automatic restarts while editing.
- `npm start` starts the server normally; open `http://localhost:3888/` for the HUD and `/settings` to configure it.
- `npm run build` runs the TypeScript compiler.

This checkout shares `node_modules` with the Windows HUD launcher. Run dependency
installation and rebuilds with Windows Node.js and `npm.cmd`, including when working
from WSL. Linux `npm install` replaces native packages such as esbuild with Linux
binaries and breaks Windows startup. Use a separate checkout for Linux dependencies.

There is no configured test or lint script. Use the build command to check TypeScript changes and manually check affected pages or integrations.

## Coding Style and Naming

Use the existing TypeScript ES module style: two-space indentation, single quotes, semicolons, and `.js` suffixes on relative imports. Use `PascalCase` for types and classes, `camelCase` for functions and variables, and kebab-case filenames. Keep provider integrations in `src/server/providers/` and implement the `IProvider` contract in `base.ts`.

## Testing Guidelines

No automated test framework or coverage requirement is configured. Keep any exploratory scripts in `scratch/`; verify production changes with `npm run build` and a focused manual check.

## Commits and Pull Requests

Git history is unavailable in this checkout, so no established commit convention could be confirmed. Use concise imperative subjects, such as `Add Slack status details`. Pull requests should describe the behavior change and validation performed, note configuration changes, link a related issue when applicable, and include screenshots for HUD or settings UI changes.

## Configuration and Secrets

Do not commit real API keys, tokens, passwords, or mail credentials from `config/config.json`. Use sanitized example values when sharing configuration changes.
