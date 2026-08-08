# Protected Firebase edge infrastructure

This Terraform root owns the pre-buffer admission boundary for the Firebase
push relay and Iroh enrollment broker in `volt-3fae7`. The checked-in
[`edge-contract.json`](./edge-contract.json) is the shared manifest for
Terraform, function-option tests, and mocked plan tests.

The load balancer has one global IPv4 address and one HTTPS frontend. There is
no HTTP forwarding rule. Cloudflare publishes DNS-only records for:

- `iroh-enrollment-us-central.volt-cli.dev`
- `push-relay-us-central.volt-cli.dev`

Exact URL-map rules route to three isolated Gen2 functions. Every unknown host,
path variant, trailing slash, or function-prefixed path reaches an empty private
backend bucket whose edge policy returns 404. Query-bearing exact paths still
select their isolated backend, where the framing policy returns 403 before
serverless dispatch.

## Toolchain and credentials

Use exactly Terraform 1.15.8. Provider selections and all transitive checksums
are committed in `.terraform.lock.hcl`.

The operator needs:

- Application Default Credentials with the project, IAM, Certificate Manager,
  Cloud Armor, Monitoring, Billing Budget, Storage, and service-usage rights;
- a Cloudflare API token scoped only to DNS edits for `volt-cli.dev`;
- the Cloudflare zone id;
- at least one stable operator source CIDR and the managed relay's stable egress
  CIDR;
- existing alert channels and one to five email-type budget channels; and
- the billing account id and reviewed monthly budget.

Set the Cloudflare token only through the environment:

```bash
export TF_VAR_cloudflare_api_token='replace-from-secret-store'
cp terraform.tfvars.example terraform.tfvars
# Replace every documentation-only value in terraform.tfvars.
```

Never commit `terraform.tfvars`, plans, state, debug logs, source IP evidence, or
credentials.

## GCS remote-state bootstrap

The backend bucket is intentionally not managed by this Terraform root. Create
it once with a globally unique operator-approved name before `terraform init`:

```bash
PROJECT_ID=volt-3fae7
TF_STATE_BUCKET='replace-volt-edge-terraform-state'
TF_STATE_LOCATION=us-central1

gcloud services enable storage.googleapis.com --project "$PROJECT_ID"
gcloud storage buckets create "gs://${TF_STATE_BUCKET}" \
  --project "$PROJECT_ID" \
  --location "$TF_STATE_LOCATION" \
  --uniform-bucket-level-access
gcloud storage buckets update "gs://${TF_STATE_BUCKET}" --versioning
gcloud storage buckets update "gs://${TF_STATE_BUCKET}" \
  --public-access-prevention=enforced

# Grant state access only to the operator group or deployment identity. Do not
# grant allUsers, allAuthenticatedUsers, project-wide basic roles, or runtime
# function service accounts.
gcloud storage buckets add-iam-policy-binding "gs://${TF_STATE_BUCKET}" \
  --member='group:replace-terraform-operators@volt-cli.dev' \
  --role='roles/storage.objectAdmin'

terraform init -backend-config="bucket=${TF_STATE_BUCKET}"
terraform providers lock \
  -platform=darwin_arm64 \
  -platform=darwin_amd64 \
  -platform=linux_amd64 \
  -platform=linux_arm64
```

Retain bucket versioning. Recovery must select and copy a reviewed historical
object generation; never delete or overwrite state to resolve drift.

## Existing-resource inventory and imports

Record a redacted inventory before the first apply. The two existing runtime
service accounts and three existing secrets are read or referenced, not
created. Import any already-created managed resource before applying it. Common
imports are:

```bash
terraform import google_service_account.callback \
  projects/volt-3fae7/serviceAccounts/volt-iroh-relay-access@volt-3fae7.iam.gserviceaccount.com
terraform import google_compute_global_address.edge \
  projects/volt-3fae7/global/addresses/volt-edge-v1
terraform import google_compute_url_map.edge \
  projects/volt-3fae7/global/urlMaps/volt-edge-v1
```

Use `terraform plan -generate-config-out=...` only in a temporary ignored file,
review the provider state, and adapt the import list to the recorded inventory.
Do not import legacy functions or generated URLs into this edge root.

## Reversible apply sequence

The complete plan intentionally reads all three new Gen2 functions and fails
preconditions unless region, ingress, service account, concurrency, memory, and
attached secret keys exactly match the manifest. Before those additive exports
exist, apply only the API/IAM foundation:

```bash
terraform plan \
  -target=google_project_service.required \
  -target=google_service_account.callback \
  -target=google_project_iam_member.runtime_database \
  -target=google_project_iam_member.runtime_log_writer \
  -target=google_project_iam_member.app_check_verifier \
  -target=google_project_iam_member.push_messaging_admin \
  -target=google_secret_manager_secret_iam_member.enrollment_ip_salt \
  -target=google_secret_manager_secret_iam_member.callback \
  -out=foundation.tfplan
terraform apply foundation.tfplan
```

Targeting is allowed only for this documented bootstrap boundary. After the
three functions are deployed by explicit Firebase targets, use complete plans:

```bash
terraform fmt -check -recursive
terraform validate
terraform test
terraform plan -out=preview.tfplan
terraform show preview.tfplan
terraform apply preview.tfplan
```

The ignored live inputs initially set all three `edge_policy_phases` entries to
`preview`. These policies evaluate malformed-envelope and rate actions in
preview, then admit only operator-owned source CIDRs. Their enforced default
deny keeps all other Internet traffic out during canary. Keep backend logging
at `1` and verify the managed certificate is `ACTIVE` before sending traffic.

Stable edge resources use manifest `edgeVersion`; retained policies use
`policyVersion`; the corrected callback final policy uses the independent
`callbackFinalPolicyVersion`. Never change an existing policy's rules after it
has been deployed. Before creating a new policy version, verify global policy,
rule, and advanced-rule quota headroom. Callback final v2 adds one policy, four
total rules, and one advanced rule.

Promote callback independently after its preview evidence passes:

```bash
terraform plan \
  -var='edge_policy_phases={callback="final",enrollment="preview",push="preview"}' \
  -out=callback-final.tfplan
terraform show callback-final.tfplan
terraform apply callback-final.tfplan
```

Require the plan to change only the callback backend policy reference, then wait
for load-balancer logs to name callback final v2 before testing. After callback
source, framing, rate, and no-invocation evidence passes, promote the public JSON
backends:

```bash
terraform plan \
  -var='edge_policy_phases={callback="final",enrollment="final",push="final"}' \
  -out=final.tfplan
terraform show final.tfplan
terraform apply final.tfplan
```

The only intended diff is the enrollment and push backend services'
`security_policy` references. Any policy rule, route, NEG, header, DNS, identity,
secret, alert, budget, stable edge resource, or frontend diff stops the rollout.
Policy resources are version-named and protected from destruction.

## Unsafe callback v1 retirement

`volt-edge-callback-final-v1` admitted throttle-conform traffic before its relay
source allow and must never be attached. The production project retired this
unattached policy under an explicit no-user waiver of the planned 24-hour soak;
that waiver does not cover any other rollback or retirement boundary.

Terraform omits only `callback_final` from the retained v1 contract map. Every
other contract policy retains `prevent_destroy`. Terraform `removed` blocks
cannot target a single `for_each` instance, so retirement used two saved plans
rather than relaxing the shared resource's lifecycle or editing state directly.

The first configuration declared an exact temporary
`google_compute_security_policy.callback_final_v1_unsafe` resource without
`prevent_destroy` and moved only
`google_compute_security_policy.contract["callback_final"]` to it. Its saved
plan was accepted only with that single `previous_address` transition, actions
`["no-op"]`, no managed side effects, and `0 to add, 0 to change, 0 to destroy`.
After applying the state-only migration, the temporary resource and move were
removed from the final configuration.

Save and structurally inspect the resulting deletion plan:

```bash
terraform plan -out=retire-unsafe-callback-v1.tfplan
terraform show -json retire-unsafe-callback-v1.tfplan \
  > retire-unsafe-callback-v1.json
```

Do not commit either artifact. The only managed side effect may be:

```text
google_compute_security_policy.callback_final_v1_unsafe: ["delete"]
```

Data-source reads and unchanged managed-resource records are expected. Any other
create, update, delete, or replacement stops retirement. Apply only the reviewed
saved plan, then require a complete zero-drift plan and prove the callback
backend still names callback final v2.

The retired policy contained five API-visible rules: three advanced-expression
rules, one source allow, and the mandatory default deny. Cloud Armor does not
charge the priority-2147483647 default rule against `SECURITY_POLICY_RULES`, so
the exact observed retirement delta is one policy, five API-visible rules, four
quota-counted non-default rules, and three advanced CEL rules. Reconcile quota
usage against both the API inventory and default-rule exclusion rather than
expecting the total API rule count to equal quota usage.

Keep the legacy exports, NEGs, IAM, relay rollback, production credentials, and
App Check canary token until their separately approved retirement.

## Admission contract

JSON routes require `POST`, an empty query string, exact JSON media type, no
`Content-Encoding`, and a canonical decimal `Content-Length` from 1 through
16,384. The callback requires `Content-Length: 0`, bounded bearer/node header
shapes, no query or content encoding, and an operator-owned relay source CIDR.
GCLB protocol validation owns declared/body-length consistency. Contract denial
is 403; rate excess is 429; URL-map rejection is 404.

Backend services overwrite, rather than append to, any client-supplied
`X-Forwarded-For` with:

```text
{client_ip_address},{server_ip_address}
```

Cloud Armor rate keys use its observed `IP`, never a forwarding header.

## Evidence and rollback

Archive only redacted plans, applied resource revisions, policy names, function
revisions, correlation ids, counts, status codes, and log queries. Never retain
callback bearers, App Check tokens, source IPs, endpoint ids, salts, FCM tokens,
or target credentials.

Before cutover, record commands that restore the old relay callback destination,
daemon/app builds, push origin, per-backend policy phases, and function exports.
A callback-only rollback while enrollment and push remain final is:

```bash
terraform plan \
  -var='edge_policy_phases={callback="preview",enrollment="final",push="final"}' \
  -out=callback-rollback.tfplan
terraform show callback-rollback.tfplan
terraform apply callback-rollback.tfplan
```

A broad rollback sets all three map values to `preview`. Require each rollback
plan to change only the intended backend policy references. Dependency-specific
rollback may also repoint traffic to the recorded old functions. Preserve
evidence before rollback and do not weaken framing to make a client pass.
