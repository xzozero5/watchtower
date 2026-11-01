# Postgres 16 with pgvector (migration 0000 runs CREATE EXTENSION), Redis for BullMQ and realtime
# fan-out, one bucket for attachments and raw inbound payloads. All private except the bucket's
# S3-interop endpoint, which is HTTPS and authenticated.
#
# No database user is created here: a password in `google_sql_user` would land in Terraform state.
# The runbook (section 5) creates the schema owner with gcloud and stores the URLs in Secret Manager.

resource "google_sql_database_instance" "main" {
  name                = "${local.name}-pg"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = var.deletion_protection

  settings {
    tier              = var.db_tier
    edition           = "ENTERPRISE"
    availability_type = var.db_availability_type
    disk_type         = "PD_SSD"
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.main.id
      ssl_mode        = "ENCRYPTED_ONLY" # [VERIFY] attribute name in the pinned provider version
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "20:00" # UTC = 03:00 Asia/Bangkok
    }

    maintenance_window {
      day  = 7
      hour = 21
    }

    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }
  }

  depends_on = [google_service_networking_connection.private_services]
}

resource "google_sql_database" "app" {
  name     = "watchtower"
  instance = google_sql_database_instance.main.name
}

resource "google_redis_instance" "main" {
  name                    = "${local.name}-redis"
  region                  = var.region
  tier                    = var.redis_tier
  memory_size_gb          = var.redis_memory_gb
  redis_version           = "REDIS_7_2"
  authorized_network      = google_compute_network.main.id
  connect_mode            = "PRIVATE_SERVICE_ACCESS"
  auth_enabled            = true
  transit_encryption_mode = "DISABLED" # in-VPC only; production decision in ADR-014 Consequences

  redis_configs = {
    # BullMQ must never lose keys to eviction.
    "maxmemory-policy" = "noeviction"
  }

  depends_on = [google_service_networking_connection.private_services]
}

resource "google_storage_bucket" "files" {
  name                        = "${var.project_id}-${local.name}-files"
  location                    = var.region
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  depends_on = [google_project_service.enabled]
}
