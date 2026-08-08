terraform {
  required_version = "= 1.15.8"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 4.52.7"
    }
    google = {
      source  = "hashicorp/google"
      version = "= 7.43.0"
    }
  }

  backend "gcs" {
    prefix = "firebase-push-relay/edge"
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "google" {
  project               = local.contract.projectId
  region                = local.contract.region
  billing_project       = local.contract.projectId
  user_project_override = true
}
