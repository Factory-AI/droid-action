# Setup Guide

## Manual Setup

**Requirements**: You must be a repository admin to complete these steps.

1. Install the Droid GitHub app to your repository: https://github.com/apps/factory-droid
2. Add `FACTORY_API_KEY` to your repository secrets. You can generate an API key at https://app.factory.ai/settings/api-keys
3. Copy the workflow file from [`examples/droid.yml`](../examples/droid.yml) into your repository's `.github/workflows/`

## Security Best Practices

**⚠️ IMPORTANT: Never commit API keys directly to your repository! Always use GitHub Actions secrets.**

To securely use your Factory API key:

1. Add your API key as a repository secret:

   - Go to your repository's Settings
   - Navigate to "Secrets and variables" → "Actions"
   - Click "New repository secret"
   - Name it `FACTORY_API_KEY`
   - Paste your API key as the value

2. Reference the secret in your workflow:
   ```yaml
   factory_api_key: ${{ secrets.FACTORY_API_KEY }}
   ```

**Never do this:**

```yaml
# ❌ WRONG - Exposes your API key
factory_api_key: "fk-..."
```

**Always do this:**

```yaml
# ✅ CORRECT - Uses GitHub secrets
factory_api_key: ${{ secrets.FACTORY_API_KEY }}
```

This applies to all sensitive values including API keys, access tokens, and credentials.
We also recommend that you always use short-lived tokens when possible

## Setting Up GitHub Secrets

1. Go to your repository's Settings
2. Click on "Secrets and variables" → "Actions"
3. Click "New repository secret"
4. For authentication, choose one:
   - API Key: Name: `FACTORY_API_KEY`, Value: Your Factory API key (starting with `fk-`)
5. Click "Add secret"

### Best Practices for Authentication

1. ✅ Always use `${{ secrets.FACTORY_API_KEY }}` in workflows
2. ✅ Never commit API keys or tokens to version control
3. ✅ Regularly rotate your API keys and tokens
4. ✅ Use environment secrets for organization-wide access
5. ❌ Never share API keys or tokens in pull requests or issues
6. ❌ Avoid logging workflow variables that might contain keys
