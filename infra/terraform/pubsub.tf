# Gmail push (T-102b/c): Gmail publishes to the topic, Pub/Sub pushes to the api with an OIDC token
# that the api verifies (audience + signer). Off until the api answers on its public hostname.

resource "google_pubsub_topic" "gmail" {
  count = var.enable_gmail_push ? 1 : 0

  name = var.gmail_pubsub_topic

  depends_on = [google_project_service.enabled]
}

# Gmail's own publisher account (PRD 11 [CONFIRMED]).
resource "google_pubsub_topic_iam_member" "gmail_publisher" {
  count = var.enable_gmail_push ? 1 : 0

  topic  = google_pubsub_topic.gmail[0].name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:gmail-api-push@system.gserviceaccount.com"
}

data "google_project" "this" {}

# Lets the Pub/Sub service agent mint OIDC tokens as the push service account. [VERIFY] role.
resource "google_service_account_iam_member" "pubsub_token_creator" {
  count = var.enable_gmail_push ? 1 : 0

  service_account_id = google_service_account.gmail_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription" "gmail_push" {
  count = var.enable_gmail_push ? 1 : 0

  name                 = "${local.name}-gmail-push"
  topic                = google_pubsub_topic.gmail[0].id
  ack_deadline_seconds = 30

  # Keep unacknowledged notifications for a day; the api acknowledges everything it can read.
  message_retention_duration = "86400s"

  expiration_policy {
    ttl = "" # never expires
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "300s"
  }

  push_config {
    push_endpoint = "${local.api_url}/v1/inbound/gmail/push"

    oidc_token {
      service_account_email = google_service_account.gmail_push.email
      audience              = "${local.api_url}/v1/inbound/gmail/push"
    }
  }

  depends_on = [google_service_account_iam_member.pubsub_token_creator]
}
