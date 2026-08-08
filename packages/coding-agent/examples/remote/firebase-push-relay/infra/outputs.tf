output "edge_ipv4_address" {
  description = "Global IPv4 address published by the two DNS-only Cloudflare records."
  value       = google_compute_global_address.edge.address
}

output "enrollment_origin" {
  description = "Fixed public enrollment origin."
  value       = "https://${local.enrollment_host}"
}

output "push_origin" {
  description = "Fixed public push origin."
  value       = "https://${local.push_host}"
}

output "attached_policy_phases" {
  description = "Policy family currently attached to each isolated serverless backend."
  value       = var.edge_policy_phases
}

output "backend_security_policies" {
  description = "Security policies attached to the isolated serverless backends."
  value = {
    for name, backend in google_compute_backend_service.function : name => backend.security_policy
  }
}

output "certificate_state" {
  description = "Managed certificate provisioning state; require ACTIVE before traffic cutover."
  value       = try(one(google_certificate_manager_certificate.edge.managed).state, "UNKNOWN")
}

output "function_contract_ids" {
  description = "Validated deployed Gen2 functions routed by the edge."
  value = {
    for name, function in data.google_cloudfunctions2_function.edge : name => function.id
  }
}
