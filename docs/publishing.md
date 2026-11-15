# Publishing `@colinleefish/rmb-dsh-plugin`

## Model

| Version | How |
|---|---|
| **First public version** (`0.1.3`) | One interactive local `npm publish` (Passkey / WebAuthn). Trusted Publishing cannot be configured until the package exists on the registry. |
| **Every later version** | Bump `package.json` → commit → `git tag vX.Y.Z` → push tag → GitHub Actions Trusted Publishing. |

Official docs: [Trusted publishers](https://docs.npmjs.com/trusted-publishers/).

## One-time: bootstrap + Trusted Publisher

1. **Done (2026-11-15):** `@colinleefish/rmb-dsh-plugin@0.1.3` was bootstrapped with a local Passkey publish. The `v0.1.3` tag also exists; its Actions run failed with “cannot publish over the previously published versions” — expected, ignore it.

2. **Still needed once on the website** — npm → package → **Settings → Trusted Publisher** → GitHub Actions:
   - Repository owner: `colinleefish`
   - Repository name: `rmb-dsh-plugin`
   - Workflow filename: `publish.yml`
   - Environment: leave empty (unless you add a GitHub Environment)

   Docs: [Trusted publishers](https://docs.npmjs.com/trusted-publishers/).

3. Confirm the package page: https://www.npmjs.com/package/@colinleefish/rmb-dsh-plugin

## Later releases

```bash
# 1. bump version in package.json (and README if needed)
# 2. commit on main
git tag v0.1.4
git push origin main --tags
```

`publish.yml` checks that the tag equals `v` + `package.json` version, then runs
`npm publish --access public --provenance` with OIDC (`id-token: write`).
No long-lived npm token in GitHub Secrets.

## Why not keep publishing from the laptop?

npm is deprecating 2FA-bypass granular tokens for direct publish. Passkey prompts
are fine once; for every release, Trusted Publishing is the durable path.
