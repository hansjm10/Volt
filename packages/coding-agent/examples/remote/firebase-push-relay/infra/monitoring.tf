resource "google_monitoring_alert_policy" "edge_log" {
  for_each = local.log_alerts

  project               = local.project_id
  display_name          = each.value.display_name
  combiner              = "OR"
  enabled               = true
  severity              = each.value.severity
  notification_channels = var.monitoring_notification_channels

  conditions {
    display_name = each.value.display_name

    condition_matched_log {
      filter = trimspace(each.value.filter)
    }
  }

  alert_strategy {
    auto_close = "1800s"

    notification_rate_limit {
      period = "300s"
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Stop rollout or use the recorded rollback procedure. Preserve redacted load-balancer and Cloud Run correlation evidence before changing policy or traffic."
  }

  depends_on = [
    google_project_service.required["logging.googleapis.com"],
    google_project_service.required["monitoring.googleapis.com"],
  ]
}

resource "google_monitoring_alert_policy" "memory_utilization" {
  project               = local.project_id
  display_name          = "Volt edge function memory utilization"
  combiner              = "OR"
  enabled               = true
  severity              = "WARNING"
  notification_channels = var.monitoring_notification_channels

  conditions {
    display_name = "99th percentile memory utilization above 85%"

    condition_threshold {
      comparison      = "COMPARISON_GT"
      duration        = "60s"
      filter          = "metric.type = \"run.googleapis.com/container/memory/utilizations\" AND resource.type = \"cloud_run_revision\""
      threshold_value = 0.85

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_PERCENTILE_99"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["resource.label.service_name"]
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Inspect only irohEnrollmentApi, irohRelayAccess, and pushRelayApi revisions. Roll back traffic if memory pressure correlates with the protected-edge rollout."
  }

  depends_on = [google_project_service.required["monitoring.googleapis.com"]]
}

resource "google_billing_budget" "project" {
  billing_account = var.billing_account_id
  display_name    = "Volt protected edge monthly project budget"

  budget_filter {
    projects        = ["projects/${data.google_project.current.number}"]
    calendar_period = "MONTH"
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_amount_usd)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }

  threshold_rules {
    threshold_percent = 0.9
  }

  threshold_rules {
    threshold_percent = 1.0
  }

  all_updates_rule {
    monitoring_notification_channels = var.budget_notification_channels
    disable_default_iam_recipients   = true
  }

  depends_on = [google_project_service.required["billingbudgets.googleapis.com"]]
}
