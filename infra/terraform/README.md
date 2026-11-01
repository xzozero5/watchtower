# infra/terraform - GCP skeleton for Watchtower (ADR-014, T-118)

**Status: skeleton. It has never been initialised, validated, planned or applied.** It creates
nothing by itself. It was written from memory of the `google` provider and may contain wrong
argument names (`[VERIFY]` comments mark the ones most likely to be off). `terraform` was not even
installed on the machine that wrote it, so `terraform fmt` was not run either.

What a human does with it, in order, is in [`docs/runbooks/staging-gcp.md`](../../docs/runbooks/staging-gcp.md).
The reasons behind every choice are in [`docs/decisions/ADR-014-gcp-deployment.md`](../../docs/decisions/ADR-014-gcp-deployment.md).

## Rules

- Do not run `terraform init`, `plan` or `apply` without the owner's say-so (`[ASK-HUMAN]`: it
  downloads providers from the registry, needs a real project and credentials, and costs money).
- One GCP project per environment. Only the owner's `*.tfvars` (git-ignored) hold project ids and
  domains; this repository uses `example.com` and placeholders.
- No secret value in Terraform, in `*.tfvars` or in state. Terraform creates empty Secret Manager
  containers; values are added with `gcloud secrets versions add ... --data-file=-`. Likewise the
  database password and the GCS HMAC key are created by hand (runbook section 5).
- No service account key is created here.

## Files

| File | What it describes |
|---|---|
| `versions.tf` | Terraform and provider versions, partial `gcs` backend |
| `variables.tf`, `terraform.tfvars.example` | Inputs. `project_id`, `base_domain`, `image_registry_path`, `smtp_relay_host` have no default |
| `locals.tf` | Secret name lists, shared environment variables (mirrors `x-app-env` in `docker-compose.yml`) |
| `network.tf` | APIs, VPC, subnet, private services access, **static egress IP + Cloud NAT** |
| `data.tf` | Cloud SQL (Postgres 16, private IP), Memorystore Redis, GCS bucket |
| `iam.tf` | Service accounts, Secret Manager containers and per-secret access, public invoker |
| `cloudrun.tf` | Artifact Registry, `web`, `api`, `worker` services and the `migrate` job |
| `pubsub.tf` | Gmail topic and push subscription (off until `enable_gmail_push = true`) |
| `lb.tf` | External Application Load Balancer, managed certificate, Cloud Armor rule for `/metrics` |
| `outputs.tf` | IPs and the exact redirect URIs / webhook URLs the credentials guide needs |

## Checks that need no network

Only these are allowed without the owner (and only when the tool is installed):

```bash
terraform fmt -recursive infra/terraform      # formatting only, reads local files
```

`terraform validate` needs `init`, which downloads the provider, so it is not run.
