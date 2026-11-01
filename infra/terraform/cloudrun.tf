resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "watchtower"
  format        = "DOCKER"
  description   = "Watchtower images: watchtower/web, watchtower/api, watchtower/worker"

  depends_on = [google_project_service.enabled]
}

locals {
  # Every service points at the same VPC subnet (Direct VPC egress).
  vpc_network    = google_compute_network.main.id
  vpc_subnetwork = google_compute_subnetwork.main.id

  # Secret env: ENV_NAME -> Secret Manager container. "latest" is read when an instance starts, so
  # rotating a value needs a new revision (runbook section 10).
  runtime_secret_env = {
    for name in local.runtime_secret_names :
    name => google_secret_manager_secret.app[name].secret_id
  }

  api_env    = merge(local.common_env, local.gmail_env, { HOST = "0.0.0.0" })
  worker_env = merge(
    local.common_env,
    local.gmail_env,
    { HOST = "0.0.0.0" },
    { for key, value in { GMAIL_SERVICE_ACCOUNT_JSON_PATH = local.gmail_key_path } : key => value if var.gmail_service_account_mounted },
  )
}

resource "google_cloud_run_v2_service" "web" {
  name                = "${local.name}-web"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  deletion_protection = var.deletion_protection

  template {
    service_account = google_service_account.web.email
    timeout         = "60s"

    scaling {
      min_instance_count = 0
      max_instance_count = var.web_max_instances
    }

    containers {
      image = "${var.image_registry_path}/web:${var.image_tag}"

      ports {
        container_port = 3000
      }

      env {
        name  = "APP_URL"
        value = local.app_url
      }
      env {
        name  = "API_URL"
        value = local.api_url
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      startup_probe {
        http_get {
          path = "/health"
        }
        period_seconds    = 5
        failure_threshold = 12
      }
    }
  }

  depends_on = [google_project_service.enabled]
}

resource "google_cloud_run_v2_service" "api" {
  name                = "${local.name}-api"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  deletion_protection = var.deletion_protection

  template {
    service_account = google_service_account.api.email
    timeout         = "3600s" # WebSocket /v1/realtime; the client reconnects at least every 15 minutes

    scaling {
      min_instance_count = var.api_min_instances
      max_instance_count = var.api_max_instances
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = local.vpc_network
        subnetwork = local.vpc_subnetwork
      }
    }

    dynamic "volumes" {
      for_each = var.gmail_service_account_mounted ? [1] : []
      content {
        name = "gmail-key"
        secret {
          secret = google_secret_manager_secret.app["GMAIL_SERVICE_ACCOUNT_JSON"].secret_id
          items {
            version = "latest"
            path    = "gmail-service-account.json"
          }
        }
      }
    }

    containers {
      image = "${var.image_registry_path}/api:${var.image_tag}"

      ports {
        container_port = 4000
      }

      dynamic "env" {
        for_each = local.api_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.runtime_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      dynamic "volume_mounts" {
        for_each = var.gmail_service_account_mounted ? [1] : []
        content {
          name       = "gmail-key"
          mount_path = "/run/secrets"
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      startup_probe {
        http_get {
          path = "/health/ready"
        }
        period_seconds    = 5
        failure_threshold = 24
      }
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_secret_manager_secret_iam_member.reader,
  ]
}

# Always on: BullMQ consumers, schedulers and the outbox relay run without any incoming request.
# CPU stays allocated (cpu_idle = false) and the single instance never scales to zero. The health
# server on $PORT is what Cloud Run probes (apps/worker/src/health.ts).
resource "google_cloud_run_v2_service" "worker" {
  name                = "${local.name}-worker"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = var.deletion_protection

  template {
    service_account = google_service_account.worker.email

    scaling {
      min_instance_count = var.worker_instances
      max_instance_count = var.worker_instances
    }

    # All traffic leaves through Cloud NAT, so the SMTP relay sees the reserved egress address.
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = local.vpc_network
        subnetwork = local.vpc_subnetwork
      }
    }

    dynamic "volumes" {
      for_each = var.gmail_service_account_mounted ? [1] : []
      content {
        name = "gmail-key"
        secret {
          secret = google_secret_manager_secret.app["GMAIL_SERVICE_ACCOUNT_JSON"].secret_id
          items {
            version = "latest"
            path    = "gmail-service-account.json"
          }
        }
      }
    }

    containers {
      image = "${var.image_registry_path}/worker:${var.image_tag}"

      ports {
        container_port = 4100
      }

      dynamic "env" {
        for_each = local.worker_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.runtime_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      dynamic "volume_mounts" {
        for_each = var.gmail_service_account_mounted ? [1] : []
        content {
          name       = "gmail-key"
          mount_path = "/run/secrets"
        }
      }

      resources {
        cpu_idle = false
        limits   = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      startup_probe {
        http_get {
          path = "/health/ready"
        }
        period_seconds    = 5
        failure_threshold = 24
      }
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_secret_manager_secret_iam_member.reader,
  ]
}

# Applies migrations as the schema owner and (re)creates the restricted login role. Run it before
# each new api/worker revision: `gcloud run jobs execute` (runbook section 7). It has the same
# image as the api (the compose `migrate` service does the same).
resource "google_cloud_run_v2_job" "migrate" {
  name                = "${local.name}-migrate"
  location            = var.region
  deletion_protection = var.deletion_protection

  template {
    template {
      service_account = google_service_account.migrate.email
      max_retries     = 0
      timeout         = "600s"

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = local.vpc_network
          subnetwork = local.vpc_subnetwork
        }
      }

      containers {
        image   = "${var.image_registry_path}/api:${var.image_tag}"
        command = ["node"]
        args    = ["node_modules/@watchtower/db/dist/cli.js", "up"]

        env {
          name  = "APP_DB_USER"
          value = "watchtower_api"
        }
        dynamic "env" {
          for_each = toset(local.migrate_secret_names)
          content {
            name = env.value
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.app[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_secret_manager_secret_iam_member.reader,
  ]
}
