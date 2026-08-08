locals {
  backend_functions = {
    enrollment = "irohEnrollmentApi"
    callback   = "irohRelayAccess"
    push       = "pushRelayApi"
  }
  certificate_hosts = {
    enrollment = local.enrollment_host
    push       = local.push_host
  }
}

resource "google_compute_backend_service" "function" {
  for_each = local.backend_functions

  project               = local.project_id
  name                  = "volt-edge-${each.key}"
  description           = "Serverless backend for ${each.value}."
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTP"
  security_policy = (
    each.key == "callback" && var.edge_policy_phases.callback == "final"
    ? google_compute_security_policy.callback_final_v2.id
    : google_compute_security_policy.contract["${each.key}_${var.edge_policy_phases[each.key]}"].id
  )
  custom_request_headers = [
    "X-Forwarded-For:{client_ip_address},{server_ip_address}",
  ]

  backend {
    group = google_compute_region_network_endpoint_group.function[each.value].id
  }

  log_config {
    enable      = true
    sample_rate = var.backend_log_sample_rate
  }
}

resource "google_storage_bucket" "reject" {
  project                     = local.project_id
  name                        = "${local.project_id}-edge-reject-${local.edge_version}"
  location                    = "US"
  force_destroy               = false
  public_access_prevention    = "enforced"
  uniform_bucket_level_access = true

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.required["storage.googleapis.com"]]
}

resource "google_compute_backend_bucket" "reject" {
  project              = local.project_id
  name                 = "volt-edge-reject-${local.edge_version}"
  description          = "Empty private bucket protected by an edge-wide deny(404) policy."
  bucket_name          = google_storage_bucket.reject.name
  enable_cdn           = false
  edge_security_policy = google_compute_security_policy.reject_edge.id
}

resource "google_certificate_manager_dns_authorization" "edge" {
  for_each = local.certificate_hosts

  project  = local.project_id
  name     = "volt-edge-${each.key}-${local.edge_version}"
  domain   = each.value
  location = "global"
  type     = "FIXED_RECORD"

  depends_on = [google_project_service.required["certificatemanager.googleapis.com"]]
}

resource "cloudflare_record" "certificate_authorization" {
  for_each = local.certificate_hosts

  zone_id = var.cloudflare_zone_id
  name = trimsuffix(
    one(google_certificate_manager_dns_authorization.edge[each.key].dns_resource_record).name,
    ".",
  )
  type = one(google_certificate_manager_dns_authorization.edge[each.key].dns_resource_record).type
  content = trimsuffix(
    one(google_certificate_manager_dns_authorization.edge[each.key].dns_resource_record).data,
    ".",
  )
  ttl     = 60
  proxied = false
}

resource "google_certificate_manager_certificate" "edge" {
  project     = local.project_id
  name        = "volt-edge-${local.edge_version}"
  description = "Managed certificate for the Volt enrollment and push edge."
  location    = "global"

  managed {
    domains = values(local.certificate_hosts)
    dns_authorizations = [
      for authorization in google_certificate_manager_dns_authorization.edge : authorization.id
    ]
  }

  depends_on = [cloudflare_record.certificate_authorization]
}

resource "google_certificate_manager_certificate_map" "edge" {
  project     = local.project_id
  name        = "volt-edge-${local.edge_version}"
  description = "Certificate map for the Volt enrollment and push edge."
}

resource "google_certificate_manager_certificate_map_entry" "edge" {
  for_each = local.certificate_hosts

  project      = local.project_id
  name         = "volt-edge-${each.key}-${local.edge_version}"
  description  = "SNI entry for ${each.value}."
  map          = google_certificate_manager_certificate_map.edge.name
  hostname     = each.value
  certificates = [google_certificate_manager_certificate.edge.id]
}

resource "google_compute_url_map" "edge" {
  project         = local.project_id
  name            = "volt-edge-${local.edge_version}"
  description     = "Exact host and path routing; every unmatched request reaches the deny(404) bucket."
  default_service = google_compute_backend_bucket.reject.id

  host_rule {
    hosts        = [local.enrollment_host]
    path_matcher = "enrollment"
  }

  host_rule {
    hosts        = [local.push_host]
    path_matcher = "push"
  }

  path_matcher {
    name            = "enrollment"
    default_service = google_compute_backend_bucket.reject.id

    path_rule {
      paths   = local.enrollment_paths
      service = google_compute_backend_service.function["enrollment"].id
    }

    path_rule {
      paths   = [local.callback_path]
      service = google_compute_backend_service.function["callback"].id
    }
  }

  path_matcher {
    name            = "push"
    default_service = google_compute_backend_bucket.reject.id

    path_rule {
      paths   = local.push_paths
      service = google_compute_backend_service.function["push"].id
    }
  }
}

resource "google_certificate_manager_certificate_map_entry" "primary" {
  project      = local.project_id
  name         = "volt-edge-primary-${local.edge_version}"
  description  = "Fail closed with the managed edge certificate for missing or unknown SNI."
  map          = google_certificate_manager_certificate_map.edge.name
  matcher      = "PRIMARY"
  certificates = [google_certificate_manager_certificate.edge.id]
}

resource "google_compute_target_https_proxy" "edge" {
  project         = local.project_id
  name            = "volt-edge-${local.edge_version}"
  description     = "HTTPS-only target proxy for the Volt protected edge."
  url_map         = google_compute_url_map.edge.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.edge.id}"

  depends_on = [
    google_certificate_manager_certificate_map_entry.edge,
    google_certificate_manager_certificate_map_entry.primary,
  ]
}

resource "google_compute_global_address" "edge" {
  project      = local.project_id
  name         = "volt-edge-${local.edge_version}"
  description  = "Stable IPv4 address for the Volt enrollment and push edge."
  address_type = "EXTERNAL"
  ip_version   = "IPV4"
}

resource "google_compute_global_forwarding_rule" "https" {
  project               = local.project_id
  name                  = "volt-edge-https-${local.edge_version}"
  description           = "The only frontend: global external managed HTTPS on port 443."
  ip_address            = google_compute_global_address.edge.id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "443"
  target                = google_compute_target_https_proxy.edge.id
}

resource "cloudflare_record" "edge" {
  for_each = local.certificate_hosts

  zone_id = var.cloudflare_zone_id
  name    = each.value
  type    = "A"
  content = google_compute_global_address.edge.address
  ttl     = 60
  proxied = false
}
