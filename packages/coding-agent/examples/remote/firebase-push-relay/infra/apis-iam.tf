data "google_project" "current" {
  project_id = local.project_id
}

resource "google_project_service" "required" {
  for_each = local.required_services

  project            = local.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "callback" {
  project      = local.project_id
  account_id   = "volt-iroh-relay-access"
  display_name = "Volt managed relay access callback"
  description  = "Dedicated runtime identity for the bodyless managed-relay admission callback."

  depends_on = [google_project_service.required["iam.googleapis.com"]]
}

resource "google_project_iam_member" "runtime_database" {
  for_each = {
    enrollment = {
      database = "volt-iroh-enrollment"
      email    = local.runtime_service_accounts.enrollment
    }
    callback = {
      database = "volt-iroh-enrollment"
      email    = google_service_account.callback.email
    }
    push = {
      database = "volt-push-relay"
      email    = local.runtime_service_accounts.push
    }
  }

  project = local.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${each.value.email}"

  condition {
    title       = "${replace(each.key, "_", "-")}-database-only"
    description = "Limit the runtime identity to its named Firestore database."
    expression  = "resource.name == 'projects/${local.project_id}/databases/${each.value.database}'"
  }

  depends_on = [google_project_service.required["firestore.googleapis.com"]]
}

resource "google_project_iam_member" "runtime_log_writer" {
  for_each = local.runtime_service_accounts

  project = local.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${each.value}"

  depends_on = [
    google_project_service.required["logging.googleapis.com"],
    google_service_account.callback,
  ]
}

resource "google_project_iam_member" "app_check_verifier" {
  for_each = toset([
    local.runtime_service_accounts.enrollment,
    local.runtime_service_accounts.push,
  ])

  project = local.project_id
  role    = "roles/firebaseappcheck.tokenVerifier"
  member  = "serviceAccount:${each.value}"

  depends_on = [google_project_service.required["firebaseappcheck.googleapis.com"]]
}

resource "google_project_iam_member" "push_messaging_admin" {
  project = local.project_id
  role    = "roles/firebasecloudmessaging.admin"
  member  = "serviceAccount:${local.runtime_service_accounts.push}"
}

data "google_secret_manager_secret" "runtime" {
  for_each = toset(concat(
    tolist(local.functions.irohEnrollmentApi.secrets),
    tolist(local.functions.irohRelayAccess.secrets),
  ))

  project   = local.project_id
  secret_id = each.value

  depends_on = [google_project_service.required["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_iam_member" "enrollment_ip_salt" {
  project   = local.project_id
  secret_id = data.google_secret_manager_secret.runtime["IROH_ENROLLMENT_IP_SALT"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.runtime_service_accounts.enrollment}"
}

resource "google_secret_manager_secret_iam_member" "callback" {
  for_each = toset(local.functions.irohRelayAccess.secrets)

  project   = local.project_id
  secret_id = data.google_secret_manager_secret.runtime[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.callback.email}"
}
