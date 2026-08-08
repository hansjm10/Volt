locals {
  contract = jsondecode(file("${path.module}/edge-contract.json"))

  project_id                    = local.contract.projectId
  region                        = local.contract.region
  edge_version                  = local.contract.edgeVersion
  policy_version                = local.contract.policyVersion
  callback_final_policy_version = local.contract.callbackFinalPolicyVersion
  enrollment_host               = local.contract.hosts.enrollment
  push_host                     = local.contract.hosts.push
  functions                     = local.contract.functions

  enrollment_paths           = tolist(local.contract.routes.enrollment)
  enrollment_expensive_paths = tolist(local.contract.routes.enrollmentExpensive)
  push_paths                 = tolist(local.contract.routes.push)
  push_registration_paths    = tolist(local.contract.routes.pushRegistration)
  callback_path              = local.contract.callback.path

  relay_source_expression = join(" || ", [
    for cidr in sort(tolist(var.relay_source_cidrs)) : "inIpRange(origin.ip, '${cidr}')"
  ])

  enrollment_expensive_path_pattern = join("|", [
    for path in local.enrollment_expensive_paths : "^${path}$"
  ])

  # Exact host/path routing is enforced by the URL map before these isolated
  # backends. Keeping framing in one expression preserves the project's finite
  # Cloud Armor advanced-rule quota without weakening backend admission.
  json_envelope_denials = [
    {
      description = "Reject invalid JSON framing"
      expression  = "request.method != 'POST' || request.query != '' || !has(request.headers['content-type']) || request.headers['content-type'].lower() != '${local.contract.body.jsonContentType}' || has(request.headers['content-encoding']) || !has(request.headers['content-length']) || !request.headers['content-length'].matches('${local.contract.body.canonicalContentLengthPattern}') || int(request.headers['content-length']) > ${local.contract.body.jsonMaximumBytes}"
      priority    = 100
    },
  ]

  callback_denials = [
    {
      description = "Reject callback framing"
      expression  = "request.method != 'POST' || request.query != '' || has(request.headers['content-encoding']) || !has(request.headers['content-length']) || request.headers['content-length'] != '${local.contract.callback.contentLength}'"
      priority    = 100
    },
    {
      description = "Reject callback authorization headers"
      expression  = "!has(request.headers['authorization']) || !request.headers['authorization'].matches('${local.contract.callback.authorizationPattern}') || !has(request.headers['x-iroh-nodeid']) || !request.headers['x-iroh-nodeid'].matches('${local.contract.callback.nodeIdPattern}')"
      priority    = 110
    },
  ]
  callback_source_denial = {
    description = "Reject callback source"
    expression  = "!(${local.relay_source_expression})"
    priority    = 120
  }
  callback_final_v2_denial_expression = join(" || ", [
    "request.method != 'POST'",
    "request.query != ''",
    "has(request.headers['content-encoding'])",
    "!has(request.headers['content-length'])",
    "request.headers['content-length'] != '${local.contract.callback.contentLength}'",
    "!has(request.headers['authorization'])",
    "!request.headers['authorization'].matches('${local.contract.callback.authorizationPattern}')",
    "!has(request.headers['x-iroh-nodeid'])",
    "!request.headers['x-iroh-nodeid'].matches('${local.contract.callback.nodeIdPattern}')",
  ])

  enrollment_expensive_rate_expression = "request.path.matches('${local.enrollment_expensive_path_pattern}')"
  enrollment_other_rate_expression     = "!request.path.matches('${local.enrollment_expensive_path_pattern}')"
  push_registration_rate_expression    = "request.path == '${one(local.push_registration_paths)}'"
  push_other_rate_expression           = "request.path != '${one(local.push_registration_paths)}'"

  policy_contracts = {
    enrollment = {
      denials = local.json_envelope_denials
      rates = [
        {
          count       = local.contract.rates.enrollmentExpensive.count
          description = "Approval and renewal per-IP throttle"
          expression  = local.enrollment_expensive_rate_expression
          interval    = local.contract.rates.enrollmentExpensive.intervalSeconds
          priority    = 200
        },
        {
          count       = local.contract.rates.jsonOther.count
          description = "Other enrollment JSON per-IP throttle"
          expression  = local.enrollment_other_rate_expression
          interval    = local.contract.rates.jsonOther.intervalSeconds
          priority    = 210
        },
      ]
    }
    callback = {
      denials = local.callback_denials
      rates = [
        {
          count       = local.contract.rates.callback.count
          description = "Managed relay callback per-IP throttle"
          expression  = "request.path == '${local.callback_path}'"
          interval    = local.contract.rates.callback.intervalSeconds
          priority    = 200
        },
      ]
    }
    push = {
      denials = local.json_envelope_denials
      rates = [
        {
          count       = local.contract.rates.pushRegistration.count
          description = "Push registration per-IP throttle"
          expression  = local.push_registration_rate_expression
          interval    = local.contract.rates.pushRegistration.intervalSeconds
          priority    = 200
        },
        {
          count       = local.contract.rates.jsonOther.count
          description = "Other push JSON per-IP throttle"
          expression  = local.push_other_rate_expression
          interval    = local.contract.rates.jsonOther.intervalSeconds
          priority    = 210
        },
      ]
    }
  }

  security_policies = merge(
    {
      for name, policy in local.policy_contracts : "${name}_preview" => merge(policy, {
        allow_source_cidrs = sort(tolist(var.operator_source_cidrs))
        denials = name == "callback" ? concat(
          policy.denials,
          [local.callback_source_denial],
        ) : policy.denials
        preview = true
      })
    },
    {
      for name, policy in local.policy_contracts : "${name}_final" => merge(policy, {
        allow_source_cidrs = name == "callback" ? sort(tolist(var.relay_source_cidrs)) : ["*"]
        preview            = false
      }) if name != "callback"
    },
  )

  runtime_service_accounts = {
    enrollment = local.functions.irohEnrollmentApi.serviceAccount
    callback   = local.functions.irohRelayAccess.serviceAccount
    push       = local.functions.pushRelayApi.serviceAccount
  }

  required_services = toset([
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "certificatemanager.googleapis.com",
    "cloudbilling.googleapis.com",
    "cloudbuild.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "eventarc.googleapis.com",
    "fcm.googleapis.com",
    "firebase.googleapis.com",
    "firebaseappcheck.googleapis.com",
    "firestore.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
  ])

  log_alerts = {
    denied_by_security_policy = {
      display_name = "Volt edge denied by security policy"
      filter       = <<-EOT
        resource.type="http_load_balancer"
        jsonPayload.statusDetails="denied_by_security_policy"
      EOT
      severity     = "WARNING"
    }
    invalid_http2_request_content_length = {
      display_name = "Volt edge invalid HTTP/2 content length"
      filter       = <<-EOT
        resource.type="http_load_balancer"
        (jsonPayload.statusDetails="invalid_http2_request_content_length" OR jsonPayload.statusDetails="invalid_http2_client_header_format")
      EOT
      severity     = "WARNING"
    }
    backend_5xx = {
      display_name = "Volt edge backend 5xx"
      filter       = <<-EOT
        resource.type="http_load_balancer"
        httpRequest.status>=500
        (httpRequest.requestUrl:"${local.enrollment_host}" OR httpRequest.requestUrl:"${local.push_host}")
      EOT
      severity     = "ERROR"
    }
    callback_denial = {
      display_name = "Volt relay callback denial"
      filter       = <<-EOT
        resource.type="http_load_balancer"
        httpRequest.requestUrl:"${local.callback_path}"
        httpRequest.status>=400
      EOT
      severity     = "ERROR"
    }
    callback_latency = {
      display_name = "Volt relay callback latency"
      filter       = <<-EOT
        resource.type="http_load_balancer"
        httpRequest.requestUrl:"${local.callback_path}"
        httpRequest.latency>"2s"
      EOT
      severity     = "WARNING"
    }
    instance_start = {
      display_name = "Volt edge function instance start"
      filter       = <<-EOT
        resource.type="cloud_run_revision"
        (resource.labels.service_name="irohenrollmentapi" OR resource.labels.service_name="irohrelayaccess" OR resource.labels.service_name="pushrelayapi")
        textPayload:"Starting new instance"
      EOT
      severity     = "WARNING"
    }
    memory_limit = {
      display_name = "Volt edge function memory limit"
      filter       = <<-EOT
        resource.type="cloud_run_revision"
        (resource.labels.service_name="irohenrollmentapi" OR resource.labels.service_name="irohrelayaccess" OR resource.labels.service_name="pushrelayapi")
        (textPayload:"memory limit" OR jsonPayload.message:"memory limit")
      EOT
      severity     = "ERROR"
    }
  }
}
