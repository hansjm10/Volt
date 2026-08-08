data "google_cloudfunctions2_function" "edge" {
  for_each = local.functions

  project  = local.project_id
  location = each.value.region
  name     = each.key

  depends_on = [google_project_service.required["cloudfunctions.googleapis.com"]]
}

resource "terraform_data" "function_contract" {
  for_each = local.functions

  input = {
    function_id = data.google_cloudfunctions2_function.edge[each.key].id
    manifest    = each.value
  }

  lifecycle {
    precondition {
      condition     = basename(data.google_cloudfunctions2_function.edge[each.key].name) == each.key
      error_message = "${each.key} does not match the function name in edge-contract.json."
    }
    precondition {
      condition     = data.google_cloudfunctions2_function.edge[each.key].location == each.value.region
      error_message = "${each.key} is not deployed in ${each.value.region}."
    }
    precondition {
      condition     = one(data.google_cloudfunctions2_function.edge[each.key].service_config).ingress_settings == each.value.ingress
      error_message = "${each.key} ingress does not match edge-contract.json."
    }
    precondition {
      condition     = one(data.google_cloudfunctions2_function.edge[each.key].service_config).service_account_email == each.value.serviceAccount
      error_message = "${each.key} runtime service account does not match edge-contract.json."
    }
    precondition {
      condition     = one(data.google_cloudfunctions2_function.edge[each.key].service_config).max_instance_request_concurrency == each.value.concurrency
      error_message = "${each.key} concurrency does not match edge-contract.json."
    }
    precondition {
      condition     = one(data.google_cloudfunctions2_function.edge[each.key].service_config).available_memory == each.value.memory
      error_message = "${each.key} memory does not match edge-contract.json."
    }
    precondition {
      condition = toset([
        for secret in one(data.google_cloudfunctions2_function.edge[each.key].service_config).secret_environment_variables : secret.key
      ]) == toset(each.value.secrets)
      error_message = "${each.key} attached secret keys do not match edge-contract.json."
    }
  }
}

resource "google_compute_region_network_endpoint_group" "function" {
  for_each = local.functions

  project               = local.project_id
  region                = each.value.region
  name                  = "volt-${lower(each.key)}"
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = basename(one(data.google_cloudfunctions2_function.edge[each.key].service_config).service)
  }

  depends_on = [terraform_data.function_contract]
}
