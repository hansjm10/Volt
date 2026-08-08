mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "546623825529"
    }
  }

  mock_data "google_secret_manager_secret" {
    defaults = {
      secret_id = "mock-secret"
    }
  }
}

mock_provider "cloudflare" {}

override_data {
  target = data.google_cloudfunctions2_function.edge["irohEnrollmentApi"]
  values = {
    id       = "projects/volt-3fae7/locations/us-central1/functions/irohEnrollmentApi"
    location = "us-central1"
    name     = "irohEnrollmentApi"
    service_config = [{
      available_memory                 = "256Mi"
      ingress_settings                 = "ALLOW_INTERNAL_AND_GCLB"
      max_instance_request_concurrency = 40
      secret_environment_variables = [{
        key = "IROH_ENROLLMENT_IP_SALT"
      }]
      service               = "projects/volt-3fae7/locations/us-central1/services/irohenrollmentapi"
      service_account_email = "volt-iroh-enrollment@volt-3fae7.iam.gserviceaccount.com"
    }]
  }
}

override_data {
  target = data.google_cloudfunctions2_function.edge["irohRelayAccess"]
  values = {
    id       = "projects/volt-3fae7/locations/us-central1/functions/irohRelayAccess"
    location = "us-central1"
    name     = "irohRelayAccess"
    service_config = [{
      available_memory                 = "256Mi"
      ingress_settings                 = "ALLOW_INTERNAL_AND_GCLB"
      max_instance_request_concurrency = 1
      secret_environment_variables = [
        { key = "IROH_RELAY_ACCESS_SECRET_CURRENT" },
        { key = "IROH_RELAY_ACCESS_SECRET_NEXT" },
      ]
      service               = "projects/volt-3fae7/locations/us-central1/services/irohrelayaccess"
      service_account_email = "volt-iroh-relay-access@volt-3fae7.iam.gserviceaccount.com"
    }]
  }
}

override_data {
  target = data.google_cloudfunctions2_function.edge["pushRelayApi"]
  values = {
    id       = "projects/volt-3fae7/locations/us-central1/functions/pushRelayApi"
    location = "us-central1"
    name     = "pushRelayApi"
    service_config = [{
      available_memory                 = "256Mi"
      ingress_settings                 = "ALLOW_INTERNAL_AND_GCLB"
      max_instance_request_concurrency = 20
      secret_environment_variables     = []
      service                          = "projects/volt-3fae7/locations/us-central1/services/pushrelayapi"
      service_account_email            = "volt-push-relay@volt-3fae7.iam.gserviceaccount.com"
    }]
  }
}

run "manifest_generated_edge_plan" {
  command = plan

  variables {
    backend_log_sample_rate      = 1
    billing_account_id           = "AAAAAA-BBBBBB-CCCCCC"
    budget_amount_usd            = 100
    budget_notification_channels = ["projects/volt-3fae7/notificationChannels/budget"]
    cloudflare_api_token         = "mock-cloudflare-token"
    cloudflare_zone_id           = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    edge_policy_phases = {
      callback   = "final"
      enrollment = "final"
      push       = "final"
    }
    monitoring_notification_channels = ["projects/volt-3fae7/notificationChannels/edge"]
    operator_source_cidrs            = ["192.0.2.10/32"]
    relay_source_cidrs               = ["198.51.100.10/32"]
  }

  assert {
    condition     = output.enrollment_origin == "https://${local.contract.hosts.enrollment}"
    error_message = "The enrollment output must be generated from edge-contract.json."
  }

  assert {
    condition     = output.push_origin == "https://${local.contract.hosts.push}"
    error_message = "The push output must be generated from edge-contract.json."
  }

  assert {
    condition = (
      length(google_compute_region_network_endpoint_group.function) == length(local.contract.functions) &&
      length(google_compute_backend_service.function) == length(local.contract.functions)
    )
    error_message = "Every manifest function must have an isolated NEG and backend."
  }

  assert {
    condition = alltrue([
      for name, function in local.contract.functions :
      terraform_data.function_contract[name].input.manifest == function
    ])
    error_message = "Function preconditions must consume the manifest values without drift."
  }

  assert {
    condition = (
      length(google_compute_security_policy.contract) == 5 &&
      !contains(keys(google_compute_security_policy.contract), "callback_final") &&
      alltrue([
        for name, policy in google_compute_security_policy.contract :
        policy.name == "volt-edge-${replace(name, "_", "-")}-${local.contract.policyVersion}"
      ])
    )
    error_message = "Preview and retained safe v1 final policies must keep their immutable manifest version."
  }

  assert {
    condition = (
      local.contract.edgeVersion == "v1" &&
      google_compute_security_policy.callback_final_v2.name == "volt-edge-callback-final-${local.contract.callbackFinalPolicyVersion}" &&
      length(split(" || ", local.callback_final_v2_denial_expression)) == 9 &&
      strcontains(local.callback_final_v2_denial_expression, "request.headers['content-length'] != '0'") &&
      strcontains(local.callback_final_v2_denial_expression, local.contract.callback.authorizationPattern) &&
      strcontains(local.callback_final_v2_denial_expression, local.contract.callback.nodeIdPattern)
    )
    error_message = "Callback final v2 must be independently versioned with one bounded advanced denial and three basic rules."
  }

  assert {
    condition = (
      strcontains(join(" ", [for denial in local.json_envelope_denials : denial.expression]), "request.method != 'POST'") &&
      strcontains(join(" ", [for denial in local.json_envelope_denials : denial.expression]), "request.query != ''") &&
      strcontains(join(" ", [for denial in local.json_envelope_denials : denial.expression]), local.contract.body.canonicalContentLengthPattern) &&
      strcontains(join(" ", [for denial in local.json_envelope_denials : denial.expression]), tostring(local.contract.body.jsonMaximumBytes)) &&
      strcontains(join(" ", [for denial in local.callback_denials : denial.expression]), "request.headers['content-length'] != '0'") &&
      alltrue([
        for policy in values(local.policy_contracts) :
        alltrue([for denial in policy.denials : !strcontains(denial.expression, " in ")])
      ]) &&
      sum([
        for policy in values(local.security_policies) :
        length(policy.denials) + length(policy.rates)
      ]) == 16
    )
    error_message = "Generated retained policies must preserve Cloud Armor-compatible framing in 16 advanced expressions."
  }

  assert {
    condition = (
      toset(local.enrollment_paths) == toset(local.contract.routes.enrollment) &&
      toset(local.push_paths) == toset(local.contract.routes.push) &&
      local.callback_path == local.contract.callback.path
    )
    error_message = "URL-map route inputs must come from the edge manifest."
  }

  assert {
    condition = (
      var.edge_policy_phases == {
        callback   = "final"
        enrollment = "final"
        push       = "final"
      } &&
      local.contract.callbackFinalPolicyVersion != local.contract.policyVersion
    )
    error_message = "Per-backend phases must permit callback v2 promotion without changing retained v1 policy names."
  }

  assert {
    condition = alltrue([
      for record in cloudflare_record.edge :
      record.proxied == false && record.type == "A"
    ])
    error_message = "Public host records must remain DNS-only A records."
  }
}
