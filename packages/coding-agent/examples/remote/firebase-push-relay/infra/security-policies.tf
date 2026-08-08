resource "google_compute_security_policy" "contract" {
  for_each = local.security_policies

  project     = local.project_id
  name        = "volt-edge-${replace(each.key, "_", "-")}-${local.policy_version}"
  description = "Immutable ${replace(each.key, "_", " ")} framing and rate contract ${local.policy_version}."
  type        = "CLOUD_ARMOR"

  dynamic "rule" {
    for_each = each.value.denials

    content {
      action      = "deny(403)"
      description = rule.value.description
      preview     = each.value.preview
      priority    = rule.value.priority

      match {
        expr {
          expression = rule.value.expression
        }
      }
    }
  }

  dynamic "rule" {
    for_each = each.value.rates

    content {
      action      = "throttle"
      description = rule.value.description
      preview     = each.value.preview
      priority    = rule.value.priority

      match {
        expr {
          expression = rule.value.expression
        }
      }

      rate_limit_options {
        conform_action = "allow"
        exceed_action  = "deny(429)"
        enforce_on_key = "IP"

        rate_limit_threshold {
          count        = rule.value.count
          interval_sec = rule.value.interval
        }
      }
    }
  }

  rule {
    action      = "allow"
    description = each.value.preview ? "Allow enforced operator canary sources" : "Allow exact public edge contract"
    priority    = 1000

    match {
      config {
        src_ip_ranges = each.value.allow_source_cidrs
      }
      versioned_expr = "SRC_IPS_V1"
    }
  }

  rule {
    action      = "deny(403)"
    description = "Default deny"
    priority    = 2147483647

    match {
      config {
        src_ip_ranges = ["*"]
      }
      versioned_expr = "SRC_IPS_V1"
    }
  }

  lifecycle {
    create_before_destroy = true
    prevent_destroy       = true
  }

  depends_on = [google_project_service.required["compute.googleapis.com"]]
}

resource "google_compute_security_policy" "callback_final_v2" {
  project     = local.project_id
  name        = "volt-edge-callback-final-${local.callback_final_policy_version}"
  description = "Immutable callback final framing, relay-source, and rate contract ${local.callback_final_policy_version}."
  type        = "CLOUD_ARMOR"

  rule {
    action      = "deny(403)"
    description = "Reject invalid callback framing or authorization headers"
    priority    = 100

    match {
      expr {
        expression = local.callback_final_v2_denial_expression
      }
    }
  }

  rule {
    action      = "throttle"
    description = "Managed relay callback per-IP throttle"
    priority    = 200

    match {
      config {
        src_ip_ranges = sort(tolist(var.relay_source_cidrs))
      }
      versioned_expr = "SRC_IPS_V1"
    }

    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"

      rate_limit_threshold {
        count        = local.contract.rates.callback.count
        interval_sec = local.contract.rates.callback.intervalSeconds
      }
    }
  }

  rule {
    action      = "allow"
    description = "Allow managed relay callback sources"
    priority    = 1000

    match {
      config {
        src_ip_ranges = sort(tolist(var.relay_source_cidrs))
      }
      versioned_expr = "SRC_IPS_V1"
    }
  }

  rule {
    action      = "deny(403)"
    description = "Default deny"
    priority    = 2147483647

    match {
      config {
        src_ip_ranges = ["*"]
      }
      versioned_expr = "SRC_IPS_V1"
    }
  }

  lifecycle {
    create_before_destroy = true
    prevent_destroy       = true
  }

  depends_on = [google_project_service.required["compute.googleapis.com"]]
}

resource "google_compute_security_policy" "reject_edge" {
  project     = local.project_id
  name        = "volt-edge-reject-${local.edge_version}"
  description = "Immutable edge 404 for unknown hosts and paths."
  type        = "CLOUD_ARMOR_EDGE"

  rule {
    action      = "deny(404)"
    description = "Reject all unmatched traffic before storage"
    priority    = 2147483647

    match {
      config {
        src_ip_ranges = ["*"]
      }
      versioned_expr = "SRC_IPS_V1"
    }
  }

  lifecycle {
    create_before_destroy = true
    prevent_destroy       = true
  }

  depends_on = [google_project_service.required["compute.googleapis.com"]]
}
