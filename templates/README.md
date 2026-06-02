# GitLab CI/CD Components

This directory is **GitLab-specific**. The path is mandated by the
[GitLab CI/CD Catalog](https://docs.gitlab.com/ee/ci/components/) — every
Component project must define its components under top-level `templates/`.

GitHub action code lives at `action.yml` (root) and `.github/workflows/`.

## Components in this directory

| File               | Component      | Usage                                                                                       |
| ------------------ | -------------- | ------------------------------------------------------------------------------------------- |
| `droid-review.yml` | `droid-review` | Automated MR code review (two-pass, optional security subagent).                            |
| `fill.yml`         | `fill`         | `@droid fill` — fills MR descriptions from the diff. Triggered via title/description/label. |

## Consuming a component

This repo is mirrored to [`gitlab.com/factory-components/droid-action`](https://gitlab.com/factory-components/droid-action). Customers include the template from the mirror:

```yaml
include:
  - project: "factory-components/droid-action"
    ref: main
    file: "/templates/droid-review.yml"
```

Once the project is marked as a [CI/CD Catalog](https://docs.gitlab.com/ee/ci/components/) project and the first tagged release is published, the shorter `component:` form also becomes available:

```yaml
include:
  - component: gitlab.com/factory-components/droid-action/droid-review@v1
```

Fallback for projects that can't reach gitlab.com (use the raw GitHub URL):

```yaml
include:
  - remote: "https://raw.githubusercontent.com/Factory-AI/droid-action/main/templates/droid-review.yml"
```

See [`../docs/gitlab-setup.md`](../docs/gitlab-setup.md) for the full setup guide and [`../gitlab/examples/`](../gitlab/examples/) for drop-in samples.
