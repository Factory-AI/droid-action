# GitLab examples

Two-file layout for consuming the droid-action GitLab CI/CD Component:

```
your-project/
├── .gitlab-ci.yml                  # gains one `include:` line
└── factory/
    └── droid-review.yml            # self-contained droid-review config
```

| File                       | Where it lives in your project                | Purpose                                                                                   |
| -------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `factory/droid-review.yml` | drop verbatim                                 | Self-contained config: includes the remote Component, sets inputs, wires CI/CD variables. |
| `.gitlab-ci.yml`           | append one `include:` line if the file exists | Project-root entry point. Just needs to include `factory/droid-review.yml`.               |

The two required CI/CD variables (`FACTORY_API_KEY`, `GITLAB_TOKEN`) are set
in the GitLab UI under **Project → Settings → CI/CD → Variables** (or at
the group level for org-wide rollout), masked and unprotected.

Use a project bot token with `api` scope. Reporter can read and post notes;
Developer or higher is needed for commit statuses and fix/report publishing.
Commands additionally require the actual note author to have active Developer
write access. The optional webhook bridge is needed to turn new notes into
pipelines; the component does not pretend GitLab has native note-triggered CI.
See [command routing and safe fork refusal](../../docs/gitlab-setup.md#commands-and-the-pipeline-bridge).

For the full input reference see the docs at [`docs/gitlab-setup.md`](../../docs/gitlab-setup.md).
