# Publishing `@colinleefish/rmb-dsh-plugin`

## Model

| Version | How |
|---|---|
| **First public version** (`0.1.3`) | One interactive local `npm publish` (Passkey / WebAuthn). Trusted Publishing cannot be configured until the package exists on the registry. |
| **Every later version** | Bump `package.json` → commit → `git tag vX.Y.Z` → push tag → GitHub Actions Trusted Publishing. |

Official docs: [Trusted publishers](https://docs.npmjs.com/trusted-publishers/).

## One-time: bootstrap + Trusted Publisher

1. Publish the first version from a real terminal (so npm can show the Passkey URL):

   ```bash
   cd rmb-dsh-plugin
   npm whoami --registry=https://registry.npmjs.org   # colinleefish
   npm publish --access public --registry=https://registry.npmjs.org
   ```

   Open the printed `https://www.npmjs.com/auth/cli/...` link, confirm with Passkey.

2. On npm → package **Settings → Trusted Publisher**:
   - Organization / user: `colinleefish`
   - Repository: `rmb-dsh-plugin`
   - Workflow filename: `publish.yml`
   - Environment: leave empty (unless you add a GitHub Environment)

3. Confirm https://www.npmjs.com/package/@colinleefish/rmb-dsh-plugin shows `0.1.3`.

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
