# One service account per workload, least privilege (PRD 8.2). No service account key is created
# here or anywhere in Terraform.

resource "google_service_account" "web" {
  account_id   = "${local.name}-web"
  display_name = "Watchtower web (${var.environment})"
}

resource "google_service_account" "api" {
  account_id   = "${local.name}-api"
  display_name = "Watchtower api (${var.environment})"
}

resource "google_service_account" "worker" {
  account_id   = "${local.name}-worker"
  display_name = "Watchtower worker (${var.environment})"
}

resource "google_service_account" "migrate" {
  account_id   = "${local.name}-migrate"
  display_name = "Watchtower migrate job (${var.environment})"
}

# Signs the OIDC token of the Gmail push subscription. It has no other permission.
resource "google_service_account" "gmail_push" {
  account_id   = "${local.name}-gmail-push"
  display_name = "Watchtower Gmail Pub/Sub push (${var.environment})"
}

# Secret Manager containers. The values are never in Terraform (runbook section 5).
resource "google_secret_manager_secret" "app" {
  for_each = local.all_secret_names

  secret_id = "${local.name}-${lower(replace(each.value, "_", "-"))}"

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

locals {
  # Secret-level (not project-level) access: api and worker read the runtime secrets, migrate
  # reads only its own two, and the Gmail key file is mounted for the worker and api.
  secret_readers = merge(
    {
      for pair in setproduct(tolist(local.runtime_secret_names), ["api", "worker"]) :
      "${pair[0]}/${pair[1]}" => { secret = pair[0], member = pair[1] }
    },
    {
      for name in local.migrate_secret_names :
      "${name}/migrate" => { secret = name, member = "migrate" }
    },
    {
      for member in ["api", "worker"] :
      "GMAIL_SERVICE_ACCOUNT_JSON/${member}" => { secret = "GMAIL_SERVICE_ACCOUNT_JSON", member = member }
      if var.gmail_service_account_mounted
    },
  )

  service_account_email = {
    api     = google_service_account.api.email
    worker  = google_service_account.worker.email
    migrate = google_service_account.migrate.email
  }
}

resource "google_secret_manager_secret_iam_member" "reader" {
  for_each = local.secret_readers

  secret_id = google_secret_manager_secret.app[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.service_account_email[each.value.member]}"
}

# The S3-interop HMAC key (created by hand) belongs to the service account that owns this grant.
resource "google_service_account" "storage" {
  account_id   = "${local.name}-storage"
  display_name = "Watchtower object storage via S3 interop (${var.environment})"
}

resource "google_storage_bucket_iam_member" "files" {
  bucket = google_storage_bucket.files.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.storage.email}"
}

# Cloud Run services are reachable only through the load balancer (ingress setting). allUsers
# invoker is what lets Pub/Sub, LINE and browsers reach them; the application authenticates each
# request itself. An organisation policy that forbids allUsers must be relaxed for this project
# first (runbook section 1, [ASK-HUMAN]).
resource "google_cloud_run_v2_service_iam_member" "public_web" {
  name     = google_cloud_run_v2_service.web.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "public_api" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
