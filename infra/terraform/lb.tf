# External Application Load Balancer in front of web and api (ADR-014 section 1 and 4).
#   app.<base_domain>  -> web
#   api.<base_domain>  -> api   (Gmail push, LINE webhook, OIDC redirects, REST, WebSocket)
# TLS is a Google-managed certificate; it becomes ACTIVE only after DNS points both names at
# `load_balancer_ip` (runbook section 4).

resource "google_compute_global_address" "lb" {
  name = "${local.name}-lb-ip"

  depends_on = [google_project_service.enabled]
}

resource "google_compute_managed_ssl_certificate" "main" {
  name = "${local.name}-cert"

  managed {
    domains = ["app.${var.base_domain}", "api.${var.base_domain}"]
  }
}

resource "google_compute_region_network_endpoint_group" "web" {
  name                  = "${local.name}-web-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.web.name
  }
}

resource "google_compute_region_network_endpoint_group" "api" {
  name                  = "${local.name}-api-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.api.name
  }
}

# Edge policy for the api. /metrics has no authentication (it is scraped inside the stack), so it
# is answered 404 here exactly like the @internal matcher in the local Caddyfile.
resource "google_compute_security_policy" "api" {
  name = "${local.name}-api-edge"

  rule {
    action   = "deny(404)"
    priority = 1000

    match {
      expr {
        expression = "request.path.matches('^/metrics(/.*)?$')"
      }
    }

    description = "Never expose /metrics"
  }

  rule {
    action   = "allow"
    priority = 2147483647

    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }

    description = "Default allow"
  }
}

resource "google_compute_backend_service" "web" {
  name                  = "${local.name}-web"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTP" # [VERIFY] serverless NEG ignores the protocol, HTTP is what the module examples use

  backend {
    group = google_compute_region_network_endpoint_group.web.id
  }
}

resource "google_compute_backend_service" "api" {
  name                  = "${local.name}-api"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTP" # [VERIFY] serverless NEG ignores the protocol, HTTP is what the module examples use
  timeout_sec           = 3600 # long-lived WebSocket
  security_policy       = google_compute_security_policy.api.id

  backend {
    group = google_compute_region_network_endpoint_group.api.id
  }
}

resource "google_compute_url_map" "main" {
  name            = "${local.name}-urlmap"
  default_service = google_compute_backend_service.web.id

  host_rule {
    hosts        = ["app.${var.base_domain}"]
    path_matcher = "web"
  }

  host_rule {
    hosts        = ["api.${var.base_domain}"]
    path_matcher = "api"
  }

  path_matcher {
    name            = "web"
    default_service = google_compute_backend_service.web.id
  }

  path_matcher {
    name            = "api"
    default_service = google_compute_backend_service.api.id
  }
}

resource "google_compute_target_https_proxy" "main" {
  name             = "${local.name}-https"
  url_map          = google_compute_url_map.main.id
  ssl_certificates = [google_compute_managed_ssl_certificate.main.id]
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "${local.name}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.main.id
}

# http -> https redirect (port 80).
resource "google_compute_url_map" "redirect" {
  name = "${local.name}-http-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  name    = "${local.name}-http"
  url_map = google_compute_url_map.redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  name                  = "${local.name}-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb.id
  port_range            = "80"
  target                = google_compute_target_http_proxy.redirect.id
}
