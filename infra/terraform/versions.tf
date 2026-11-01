# SKELETON - never applied, never initialised (ADR-014, T-118). See README.md before touching it.

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0" # [VERIFY] pin to the current major when the owner runs `terraform init`
    }
  }

  # Partial configuration: pass the bucket at init time, e.g.
  #   terraform init -backend-config="bucket=<state bucket>" -backend-config="prefix=watchtower/staging"
  # The state bucket is created by hand (runbook section 2), never by this root module.
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}
