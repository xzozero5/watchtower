output "app_url" {
  description = "APP_URL: where staff and clients open the web app."
  value       = local.app_url
}

output "api_url" {
  description = "API_URL: base of every redirect URI and webhook (ADR-014 section 4)."
  value       = local.api_url
}

output "load_balancer_ip" {
  description = "Point the DNS A records of app.<base_domain> and api.<base_domain> here."
  value       = google_compute_global_address.lb.address
}

output "egress_ip" {
  description = "The address to give the SMTP relay owner for the allow-list. Worker traffic leaves from here."
  value       = google_compute_address.egress.address
}

output "google_oidc_redirect_uri" {
  value = "${local.api_url}/v1/auth/google/callback"
}

output "line_login_callback_url" {
  value = "${local.api_url}/v1/line/login/callback"
}

output "line_webhook_url_template" {
  description = "Replace {channelAccountId} with the id returned by POST /v1/admin/channel-accounts (its response also carries the ready-made webhookUrl)."
  value       = "${local.api_url}/v1/inbound/line/{channelAccountId}"
}

output "gmail_push_endpoint" {
  value = "${local.api_url}/v1/inbound/gmail/push"
}

output "gmail_push_service_account" {
  description = "GMAIL_PUSH_SERVICE_ACCOUNT."
  value       = google_service_account.gmail_push.email
}

output "storage_service_account" {
  description = "Create the S3-interop HMAC key for this account by hand (runbook section 5)."
  value       = google_service_account.storage.email
}

output "cloud_sql_instance" {
  value = google_sql_database_instance.main.name
}

output "cloud_sql_private_ip" {
  description = "Host part of DATABASE_URL / MIGRATION_DATABASE_URL."
  value       = google_sql_database_instance.main.private_ip_address
}

output "redis_host" {
  description = "Host part of REDIS_URL (port is redis_port)."
  value       = google_redis_instance.main.host
}

output "redis_port" {
  value = google_redis_instance.main.port
}

output "bucket" {
  description = "S3_BUCKET."
  value       = google_storage_bucket.files.name
}

output "secret_ids" {
  description = "Secret Manager containers waiting for a value."
  value       = { for name, secret in google_secret_manager_secret.app : name => secret.secret_id }
}
