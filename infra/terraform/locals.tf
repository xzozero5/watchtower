locals {
  name    = "wt-${var.environment}"
  app_url = "https://app.${var.base_domain}"
  api_url = "https://api.${var.base_domain}"

  # Secrets that the api and worker need to boot in production. Terraform creates only the empty
  # Secret Manager containers; values are added by hand (runbook section 5) so they never enter state.
  required_secret_names = [
    "APP_ENCRYPTION_KEY",
    "DATABASE_URL",
    "JWT_SECRET",
    "REDIS_URL",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
  ]

  # Integration secrets: created now, referenced only when listed in var.enabled_optional_secrets.
  optional_secret_names = [
    "ANTHROPIC_API_KEY",
    "BREAK_GLASS_PASSWORD",
    "DISCORD_BOT_TOKEN",
    "DISCORD_WEBHOOK_URL",
    "GOOGLE_OIDC_CLIENT_SECRET",
    "LINE_CHANNEL_ACCESS_TOKEN",
    "LINE_CHANNEL_SECRET",
    "LINE_LOGIN_CHANNEL_SECRET",
    "PORTAL_TOKEN_SECRET",
    "SMTP_PASSWORD",
    "SMTP_USER",
  ]

  # Used only by the migrate job (schema owner), never by the long-running services.
  migrate_secret_names = [
    "APP_DB_PASSWORD",
    "MIGRATION_DATABASE_URL",
  ]

  file_secret_names = ["GMAIL_SERVICE_ACCOUNT_JSON"]

  all_secret_names = toset(concat(
    local.required_secret_names,
    local.optional_secret_names,
    local.migrate_secret_names,
    local.file_secret_names,
  ))

  runtime_secret_names = toset(concat(
    local.required_secret_names,
    tolist(var.enabled_optional_secrets),
  ))

  # Plain settings shared by api and worker (names match the x-app-env table in docker-compose.yml).
  common_env = merge(
    {
      NODE_ENV          = "production"
      LOG_LEVEL         = "info"
      APP_URL           = local.app_url
      API_URL           = local.api_url
      S3_ENDPOINT       = "https://storage.googleapis.com"
      S3_REGION         = "auto" # [VERIFY] region string GCS accepts for SigV4 on the interop endpoint
      S3_BUCKET         = google_storage_bucket.files.name
      TRUST_PROXY_HOPS  = tostring(var.trust_proxy_hops)
      TICKET_KEY_PREFIX = var.ticket_key_prefix
      SMTP_HOST         = var.smtp_relay_host
      SMTP_PORT         = tostring(var.smtp_relay_port)
      SMTP_FROM         = var.smtp_from
    },
    var.extra_env,
  )

  # merge() with a for-if keeps the type a plain map whether or not Gmail push is on.
  gmail_env = merge({
    for key, value in {
      PUBSUB_PROJECT_ID          = var.project_id
      PUBSUB_TOPIC               = var.gmail_pubsub_topic
      GMAIL_PUSH_AUDIENCE        = "${local.api_url}/v1/inbound/gmail/push"
      GMAIL_PUSH_SERVICE_ACCOUNT = google_service_account.gmail_push.email
    } : key => value
    if var.enable_gmail_push
  })

  gmail_key_path = "/run/secrets/gmail-service-account.json"
}
