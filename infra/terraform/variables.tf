variable "project_id" {
  description = "GCP project that holds this environment. One project per environment (ADR-014). No default on purpose."
  type        = string
}

variable "region" {
  description = "Region for every regional resource. [ASSUMED] asia-southeast1, confirm with the owner."
  type        = string
  default     = "asia-southeast1"
}

variable "environment" {
  description = "staging or production."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "base_domain" {
  description = "Domain the instance owner controls, e.g. staging.example.com. The app is served at app.<base_domain> and the api at api.<base_domain> (same site, ADR-014 section 4)."
  type        = string
}

variable "image_registry_path" {
  description = "Artifact Registry path without tag, e.g. <region>-docker.pkg.dev/<project>/watchtower. Images are watchtower/web, api and worker."
  type        = string
}

variable "image_tag" {
  description = "Tag (or @sha256 digest) of the three images to run. Pin a digest for production."
  type        = string
  default     = "latest"
}

variable "deletion_protection" {
  description = "Protects Cloud SQL and the Cloud Run services from `terraform destroy` (the bucket is protected by force_destroy = false: it must be emptied by hand). Keep true; turn off only for a deliberate teardown."
  type        = bool
  default     = true
}

# --- sizing ([ASSUMED] starting points, not measured) ---

variable "db_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-custom-1-3840"
}

variable "db_availability_type" {
  description = "ZONAL for staging, REGIONAL (HA) for production."
  type        = string
  default     = "ZONAL"
}

variable "redis_tier" {
  description = "BASIC for staging, STANDARD_HA for production."
  type        = string
  default     = "BASIC"
}

variable "redis_memory_gb" {
  type    = number
  default = 1
}

variable "api_min_instances" {
  description = "0 on staging, 1 on production (cold start and open WebSockets)."
  type        = number
  default     = 0
}

variable "api_max_instances" {
  type    = number
  default = 3
}

variable "web_max_instances" {
  type    = number
  default = 3
}

variable "worker_instances" {
  description = "Min and max of the worker. Always-on; 1 is enough for staging."
  type        = number
  default     = 1
}

# --- application settings (non-secret; secrets live in Secret Manager) ---

variable "trust_proxy_hops" {
  description = "TRUST_PROXY_HOPS of the api. Expected 2 behind Cloud Run + external load balancer. [UNVERIFIED 60%] measure it in staging (runbook section 9) before opening webhooks."
  type        = number
  default     = 2
}

variable "ticket_key_prefix" {
  type    = string
  default = "OPS"
}

variable "google_allowed_domain" {
  description = "Workspace domain allowed to sign in with Google (GOOGLE_ALLOWED_DOMAIN)."
  type        = string
  default     = "example.com"
}

variable "smtp_relay_host" {
  description = "Host of the owner's SMTP relay (SMTP_HOST must be non-empty or the worker will not boot). No default on purpose."
  type        = string
}

variable "smtp_relay_port" {
  description = "465 (implicit TLS) or 587 (STARTTLS). Never 25 [VERIFY outbound 25 is blocked on GCP]."
  type        = number
  default     = 587
}

variable "smtp_from" {
  type    = string
  default = "Watchtower <no-reply@example.com>"
}

variable "gmail_pubsub_topic" {
  description = "Topic id (not the full path) that Gmail users.watch publishes to."
  type        = string
  default     = "watchtower-gmail"
}

variable "enable_gmail_push" {
  description = "Create the Pub/Sub topic and push subscription. Turn on after the api answers on https://api.<base_domain>."
  type        = bool
  default     = false
}

variable "gmail_service_account_mounted" {
  description = "Mount secret gmail_service_account_json read-only at /run/secrets/gmail-service-account.json (domain-wide delegation key)."
  type        = bool
  default     = false
}

variable "enabled_optional_secrets" {
  description = "Optional secrets (see local.optional_secret_names) that a service should read as env. Cloud Run refuses to start a revision that points at a secret without a version, so add a name here only after its value was set."
  type        = set(string)
  default     = []
}

variable "extra_env" {
  description = "Extra plain (non-secret) environment variables for api and worker, e.g. LINE_CHANNEL_ID, GMAIL_IMPERSONATE_USER, AI_PROVIDER."
  type        = map(string)
  default     = {}
}
