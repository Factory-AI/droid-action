# Bitbucket templates

Copy-ready CI files that run the Droid code review on Bitbucket pull requests. Each one clones droid-action at `DROID_ACTION_REF` and runs [`droid-review.sh`](droid-review.sh), so the files stay small and pick up fixes without edits.

| File                                                                     | Variant                | Where it goes in your repository                                                 |
| ------------------------------------------------------------------------ | ---------------------- | -------------------------------------------------------------------------------- |
| [`pipelines/bitbucket-pipelines.yml`](pipelines/bitbucket-pipelines.yml) | Cloud, one repository  | `bitbucket-pipelines.yml` at the root, or merge its step into your existing file |
| [`pipelines/shared-pipeline.yml`](pipelines/shared-pipeline.yml)         | Cloud, whole workspace | `bitbucket-pipelines.yml` of a central repository (Bitbucket Cloud Premium)      |
| [`examples/Jenkinsfile`](examples/Jenkinsfile)                           | Data Center, Jenkins   | `Jenkinsfile` at the root, or add its stage to your existing one                 |
| [`examples/bamboo-specs.yml`](examples/bamboo-specs.yml)                 | Data Center, Bamboo    | `bamboo-specs/bamboo.yml`                                                        |

With the shared pipeline, each repository in the workspace needs only:

```yaml
pipelines:
  pull-requests:
    "**":
      import: droid-pipelines:main:droid-review
```

Every template needs two secrets, stored as secured or masked variables:

- `FACTORY_API_KEY`: generate one at <https://app.factory.ai/settings/api-keys>.
- `DROID_BITBUCKET_TOKEN`: a Bitbucket access token that can read the pull request and post comments.

Jenkins and Bamboo map these from their own credential names; see the comments at the top of each file.

For credentials, inputs, other CI systems, enforcement, and troubleshooting, see [`docs/bitbucket-setup.md`](../docs/bitbucket-setup.md). To set this up for you, run `/install-code-review` in the Droid CLI.
