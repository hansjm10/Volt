variable "cloudflare_api_token" {
  description = "Scoped Cloudflare token allowed to edit DNS for volt-cli.dev."
  type        = string
  sensitive   = true

  validation {
    condition     = length(trimspace(var.cloudflare_api_token)) > 0
    error_message = "cloudflare_api_token must not be empty."
  }
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id for volt-cli.dev."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be a 32-character lowercase hexadecimal zone id."
  }
}

variable "operator_source_cidrs" {
  description = "Operator-owned source CIDRs enforced while preview policies are attached."
  type        = set(string)

  validation {
    condition = (
      length(var.operator_source_cidrs) > 0 &&
      alltrue([for cidr in var.operator_source_cidrs : can(cidrhost(cidr, 0))])
    )
    error_message = "operator_source_cidrs must contain at least one valid CIDR."
  }
}

variable "relay_source_cidrs" {
  description = "Stable operator-owned egress CIDRs used by the managed relay callback."
  type        = set(string)

  validation {
    condition = (
      length(var.relay_source_cidrs) > 0 &&
      alltrue([for cidr in var.relay_source_cidrs : can(cidrhost(cidr, 0))])
    )
    error_message = "relay_source_cidrs must contain at least one valid CIDR."
  }
}

variable "edge_policy_phases" {
  description = "Policy family attached to each isolated backend. Preview is operator-only; final admits that backend's public contract."
  type = object({
    callback   = string
    enrollment = string
    push       = string
  })
  default = {
    callback   = "preview"
    enrollment = "preview"
    push       = "preview"
  }

  validation {
    condition = alltrue([
      for phase in values(var.edge_policy_phases) : contains(["preview", "final"], phase)
    ])
    error_message = "Every edge_policy_phases value must be preview or final."
  }
}

variable "backend_log_sample_rate" {
  description = "Load-balancer request-log sampling rate. Keep at 1 during canary and soak."
  type        = number
  default     = 1

  validation {
    condition     = var.backend_log_sample_rate >= 0 && var.backend_log_sample_rate <= 1
    error_message = "backend_log_sample_rate must be between 0 and 1."
  }
}

variable "monitoring_notification_channels" {
  description = "Full Cloud Monitoring notification-channel resource names used for edge alerts."
  type        = list(string)

  validation {
    condition = (
      length(var.monitoring_notification_channels) > 0 &&
      length(var.monitoring_notification_channels) <= 16 &&
      alltrue([
        for channel in var.monitoring_notification_channels :
        can(regex("^projects/[^/]+/notificationChannels/[^/]+$", channel))
      ])
    )
    error_message = "monitoring_notification_channels must contain 1-16 full notification-channel names."
  }
}

variable "billing_account_id" {
  description = "Billing account id that owns the project budget, without the billingAccounts/ prefix."
  type        = string

  validation {
    condition     = can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account_id))
    error_message = "billing_account_id must use the XXXXXX-XXXXXX-XXXXXX format."
  }
}

variable "budget_amount_usd" {
  description = "Monthly project budget in whole USD."
  type        = number

  validation {
    condition     = var.budget_amount_usd == floor(var.budget_amount_usd) && var.budget_amount_usd > 0
    error_message = "budget_amount_usd must be a positive whole-dollar amount."
  }
}

variable "budget_notification_channels" {
  description = "One to five email-type Cloud Monitoring channels accepted by Cloud Billing budgets."
  type        = list(string)

  validation {
    condition = (
      length(var.budget_notification_channels) > 0 &&
      length(var.budget_notification_channels) <= 5 &&
      alltrue([
        for channel in var.budget_notification_channels :
        can(regex("^projects/[^/]+/notificationChannels/[^/]+$", channel))
      ])
    )
    error_message = "budget_notification_channels must contain 1-5 full email notification-channel names."
  }
}
