# Self-hosted iroh relay

Volt uses [iroh](https://www.iroh.computer/) for daemon-to-phone transport. The
daemon defaults to the Volt-operated relay fleet. The n0 public relays remain a
development-only opt-in with `VOLT_IROH_RELAY_MODE=development`.

There are two distinct deployment models:

- **Volt-managed fleet:** iroh-relay asks the fixed Volt enrollment backend
  whether an endpoint ID may register. The backend authenticates the relay with
  a server-to-server bearer secret. Neither pairing tickets nor the App Store
  app receive that secret.
- **Owner-operated custom relay:** the relay is intentionally uncredentialed
  from the app's perspective. Its owner may make it explicitly open or maintain
  an endpoint-ID allowlist. The official app sends no App Check material or
  durable relay credential to a custom relay.

`scripts/deploy-iroh-relay.sh` supports both models. Its managed mode accepts
only Volt's exact production callback URL, preventing the relay bearer from
being redirected to an operator-supplied origin. Use `--open` or `--allowlist`
for a custom self-hosted relay.

Relayed traffic is end-to-end encrypted by iroh. The relay forwards opaque
packets between endpoint IDs; owning the relay changes infrastructure control
and availability, not payload confidentiality.

## Important stock-relay limitation

In iroh-relay v1.0.3, `access.http` runs one HTTP decision when an endpoint
registers with the relay. It is not continuous authorization:

- revocation or grant expiry takes effect on the endpoint's next registration;
- changing the backend decision cannot interrupt an already active relay
  registration or its flows;
- the callback cannot meter bytes per endpoint; and
- a backend outage denies new registrations, but does not terminate active
  registrations.

Active-session reauthorization and per-endpoint byte quotas require upstream
relay support or a separately reviewed relay fork. The deployment script adds
relay-wide process, file-descriptor, ingress, and kernel egress backstops, but
does not claim that those are per-endpoint accounting.

## Prerequisites

- A dedicated Ubuntu 24.04 or current Debian VPS with public IPv4 and, ideally,
  IPv6.
- A DNS name such as `relay.example.com` with its A record already pointing at
  the VPS. Add an AAAA record when IPv6 is available.
- Root SSH access.
- `curl`, `systemd` 247 or newer, and `nft` from the `nftables` package.
- Python 3.10 or newer when deploying a Volt-managed relay.
- Provider firewall rules allowing only 80/tcp, 443/tcp, and 7824/udp in
  addition to SSH.

The deployment fails closed if it cannot install the nftables owner-based
egress rule. It stops the relay before replacing that rule and starts the relay
only after nftables accepts and exposes the configured counter. Do not run
other services as the dedicated `iroh-relay` user, because the ceiling applies
to all output owned by that UID. The managed deployment's bounded callback
framing proxy is the only expected exception.

## DNS and ports

Create the records before deployment:

```text
relay.example.com.  A     <server IPv4>
relay.example.com.  AAAA  <server IPv6>   # optional
```

Open exactly:

| Port | Protocol | Purpose |
| --- | --- | --- |
| 80 | TCP | Iroh captive-portal probe service |
| 443 | TCP | Relay HTTPS, websocket traffic, TLS, and `/healthz` |
| 7824 | UDP | QUIC address discovery |

Metrics bind only to `127.0.0.1:9090` in the generated configuration.

## Install iroh-relay

Volt requires iroh-relay v1.0.3 or newer for `access.http`; the deployment
script pins v1.0.3 by default. For a manual x86-64 installation:

```sh
curl -sSLO https://github.com/n0-computer/iroh/releases/download/v1.0.3/iroh-relay-v1.0.3-x86_64-unknown-linux-gnu.tar.gz
printf '%s  %s\n' \
  ad7de882c4825a851b38869a3f1622b674cb65f344304e432f862ddf72d6b39a \
  iroh-relay-v1.0.3-x86_64-unknown-linux-gnu.tar.gz | sha256sum --check --strict -
tar xzf iroh-relay-v1.0.3-x86_64-unknown-linux-gnu.tar.gz
sudo install -m 0755 iroh-relay /usr/local/bin/iroh-relay
iroh-relay --version
```

Use the matching `aarch64-unknown-linux-gnu` artifact on ARM; its reviewed
v1.0.3 SHA-256 is
`278010f9757e70e077ded3b1d2893b9b1f66cce6076603b7f0eebc175cd116f1`.
The deployment script rejects versions/architectures without a pinned digest.

## Volt-managed enrollment backend

The enrollment backend exposes `POST /v1/relay-access`. Stock iroh-relay sends:

- `Authorization: Bearer <server-to-server secret>`; and
- `X-Iroh-NodeId: <64 lowercase-hex endpoint ID>`.

Only an exact `200 text/plain` response body of `true` authorizes registration.
Every other body, status, timeout, or network error denies it. The backend
accepts its configured **current** or **next** relay secret using timing-safe
comparison.

Stock iroh-relay v1.0.3 omits `Content-Length` on this empty POST. Google Cloud
Functions rejects that request with HTTP 411 before invoking the enrollment
backend. Managed deployments therefore install a loopback-only framing proxy
that adds `Content-Length: 0` and forwards only `Authorization` and
`X-Iroh-NodeId` to the fixed callback above. It rejects request bodies,
redirects, malformed endpoint IDs, duplicate headers, oversized responses, and
all other paths. The bearer still enters only the relay process; the proxy
receives it over loopback and has no credential file or client-facing listener.

Configure the backend's current secret before starting a relay. Then provision
the same raw value as a single line in a root-owned file on each relay host. A
safe interactive transfer that does not place the value in command arguments
or output is:

```sh
read -rsp 'Current relay/backend secret: ' RELAY_BACKEND_SECRET; echo
printf '%s\n' "$RELAY_BACKEND_SECRET" | ssh root@relay.example.com '
  set -eu
  umask 077
  install -d -o root -g root -m 0755 /etc/iroh-relay
  tmp=$(mktemp /etc/iroh-relay/http-bearer-token.XXXXXX)
  trap '\''rm -f "$tmp"'\'' EXIT
  cat > "$tmp"
  chown root:root "$tmp"
  chmod 0400 "$tmp"
  mv "$tmp" /etc/iroh-relay/http-bearer-token
'
unset RELAY_BACKEND_SECRET
```

Use a 32-512 character printable, non-space secret from the same secret manager
used to configure the backend. Do not put it in:

- `--access-http-url` or another command-line argument;
- `/etc/iroh-relay/config.toml`;
- an `ExecStart=` argument;
- a pairing ticket, app configuration, or daemon environment; or
- shell tracing, deployment logs, or monitoring labels.

The script validates that the source is a non-symlink regular file owned by
root with mode 0400 or 0600. systemd `LoadCredential=` reads it before changing
to the `iroh-relay` user. A root-owned wrapper exports the value to the relay as
`IROH_RELAY_HTTP_BEARER_TOKEN`, which v1.0.3 consumes. The source secret is not
present in relay TOML or process arguments.

Deploy after the backend and file are ready:

```sh
scripts/deploy-iroh-relay.sh root@relay.example.com relay.example.com \
  --contact you@example.com \
  --access-http-url https://us-central1-volt-3fae7.cloudfunctions.net/irohEnrollment/v1/relay-access
```

Use `--access-http-token-file <remote-absolute-path>` only when the root-owned
file is not at `/etc/iroh-relay/http-bearer-token`.

The relevant generated TOML is:

```toml
http_bind_addr = "[::]:80"
enable_quic_addr_discovery = true
enable_metrics = true
metrics_bind_addr = "127.0.0.1:9090"
key_cache_capacity = 16384

[limits.client.rx]
bytes_per_second = 16777216
max_burst_bytes = 33554432

[tls]
https_bind_addr = "[::]:443"
quic_bind_addr = "[::]:7824"
hostname = "relay.example.com"
cert_mode = "LetsEncrypt"
prod_tls = true
cert_dir = "/var/lib/iroh-relay/certs"

[access.http]
url = "http://127.0.0.1:9081/v1/relay-access"
```

There is deliberately no `bearer_token` key in this file. The generated local
URL is fixed, and `/usr/local/libexec/iroh-relay-access-proxy.py` independently
pins the production enrollment callback; operator input cannot redirect the
bearer.

### Rotate the backend secret with current/next overlap

Rotate one fleet at a time and keep both backend slots valid throughout the
rollout:

1. Generate a new secret without printing it. Configure it as the backend's
   **next** secret while retaining the old **current** secret. Deploy the
   backend and verify that both values authenticate.
2. On one relay at a time, atomically replace its root-owned token file with the
   next value through stdin, then rerun the deployment script or restart
   `iroh-relay`. `LoadCredential=` is reread only when the service starts.
3. Verify `iroh-relay-healthcheck.service`, `/healthz`, and normal endpoint
   registration after each relay. Keep enough other relays online because a
   restart interrupts registrations on that relay even though changing the
   backend secret alone cannot do so.
4. After every relay uses the next value, promote that value to backend
   **current** and clear backend **next**. Retire the old value only then.

Before step 4, rollback consists of restoring the old root-owned relay file and
restarting that relay; the backend still accepts it. Never replace current and
next simultaneously, and never remove current before all relay processes have
loaded next.

## Custom uncredentialed relay

A custom relay does not participate in Volt-managed enrollment. Choose its
owner-controlled policy explicitly.

Open custom relay:

```sh
scripts/deploy-iroh-relay.sh root@relay.example.com relay.example.com \
  --contact you@example.com \
  --open
```

Endpoint allowlist:

```sh
scripts/deploy-iroh-relay.sh root@relay.example.com relay.example.com \
  --contact you@example.com \
  --allowlist '<daemon-endpoint-id>,<phone-endpoint-id>'

scripts/deploy-iroh-relay.sh root@relay.example.com \
  --add-allow '<new-endpoint-id>'
```

The allowlist is practical only when the owner can obtain and maintain every
endpoint ID. An open relay relies on network ownership plus the deployment's
resource and egress ceilings; it is not appropriate for an unrestricted
high-capacity public service.

Point a daemon at an owner-operated custom relay with:

```sh
VOLT_IROH_RELAY_URLS=https://relay.example.com volt daemon run
```

The pairing ticket carries the custom relay origin, not a shared bearer token.
The app treats the origin as custom uncredentialed transport. Do not configure
the managed callback for an arbitrary custom origin: the official app enrolls
only through its fixed Volt broker and validates the managed fleet origins that
broker returns.

## Resource and egress controls

The generated relay systemd unit includes:

- `LimitNOFILE=16384` as a hard file-descriptor and socket-concurrency bound;
- `TasksMax=256`;
- `MemoryHigh=640M` and `MemoryMax=768M`;
- `CPUQuota=100%`;
- `IPAccounting=true`; and
- service sandboxing with only `CAP_NET_BIND_SERVICE` and write access to
  `/var/lib/iroh-relay`.

Stock iroh-relay has no first-class maximum-active-endpoints setting. Although
v1.0.3 parses `accept_conn_limit` and `accept_conn_burst`, its source marks them
unimplemented, so the generated config does not pretend they provide a bound.
The file-descriptor ceiling is the coarse aggregate connection backstop, while
`[limits.client.rx]` enforces per-client ingress.

Managed deployments also run `iroh-relay-access-proxy.service` with a
loopback-only listener, a 96 MiB memory ceiling, 32-task ceiling, 25% CPU quota,
and no Linux capabilities. The separate `iroh-relay-egress.service` installs
an nftables `inet` output rule matching the numeric `iroh-relay` UID. Defaults
are an aggregate
67,108,864 bytes/second with a 134,217,728-byte burst. Override them at deploy
time when the VPS capacity requires a lower value:

```sh
scripts/deploy-iroh-relay.sh root@relay.example.com relay.example.com \
  --open \
  --egress-bytes-per-second 16777216 \
  --egress-burst-bytes 33554432
```

This kernel rule is the enforceable relay-wide ceiling. `IPAccounting` and
relay metrics are observability counters, not enforcement. The health monitor
stops the relay if the nftables table/counter disappears.

## Health checks, alerts, and runbook

The deployment installs and enables `iroh-relay-healthcheck.timer`. Each run:

1. resolves the configured relay hostname to IPv4 or IPv6 loopback and requests
   its TLS `/healthz`;
2. for managed relays, sends the backend bearer through curl stdin to the
   loopback framing proxy and expects an authenticated 400 response to a
   deliberately incomplete request, proving proxy health, backend reachability,
   and secret acceptance without creating an endpoint record or consuming the
   endpoint request quota;
3. confirms that the nftables egress guard exists; and
4. detects increases in its dropped-byte counter.

No probe places the backend secret in curl arguments or emits it in output.
State transitions are logged with tag `iroh-relay-monitor`. If a root-owned
executable `/etc/iroh-relay/alert-hook` exists, it receives three non-secret
arguments:

```text
<check-name> <ok|failed|limited> <detail>
```

Copy `/etc/iroh-relay/alert-hook.example`, replace its body with the monitoring
integration, then set owner `root:root` and mode 0755. Keep webhook credentials
in a separate root-readable file rather than in the hook's command arguments.

Useful checks:

```sh
systemctl status iroh-relay iroh-relay-access-proxy iroh-relay-egress iroh-relay-healthcheck.timer
journalctl -u iroh-relay -u iroh-relay-access-proxy -u iroh-relay-healthcheck --since -30m
curl --resolve relay.example.com:443:127.0.0.1 -sSf https://relay.example.com/healthz
curl -sSf http://127.0.0.1:9090/metrics | head
nft list counter inet volt_iroh_relay egress_rate_dropped
systemctl show iroh-relay -p IPIngressBytes -p IPEgressBytes
```

Runbook:

- **Relay health failed:** inspect relay logs, DNS, certificate issuance, local
  ports, and memory/FD limits. Restart only after identifying the failure.
- **Backend health failed:** verify `iroh-relay-access-proxy.service`, the fixed
  URL, backend deployment, and the current/next secret overlap. Do not bypass
  the outage with `--open`; failed
  authorization must remain fail closed. Existing registrations may continue
  because stock authorization is registration-time only.
- **Egress guard missing:** the monitor stops `iroh-relay`. Restore nftables,
  then run `systemctl restart iroh-relay-egress` followed by
  `systemctl restart iroh-relay`.
- **Egress pressure limited:** inspect the nftables counter,
  `IPEgressBytes`, relay metrics, connection counts, and provider network
  graphs. Treat unexpected growth as abuse or a capacity incident. Raise the
  ceiling only after investigation; the relay cannot attribute or cap bytes per
  endpoint.
- **Repeated connection or memory pressure:** add capacity or another relay,
  rather than removing the ceilings. Keep metrics on loopback and export them
  through an authenticated monitoring agent.

Also configure an external HTTPS probe for `https://relay.example.com/healthz`
and alerts for timer failures, systemd restart loops, memory pressure,
file-descriptor exhaustion, sustained egress near the configured ceiling, and
any egress drops.

## Multiple relays and discovery

Iroh probes the relays in its map and selects a nearby home relay. Peers on
different home relays can still reach one another. Add a Volt-managed region by
deploying it with the same callback contract, returning its normalized HTTPS
origin from the enrollment backend, and updating the managed fleet origins.
Roll fleet and secret changes with overlap.

Moving relay traffic does not replace endpoint discovery. Volt still uses the
n0 preset's DNS/pkarr discovery so reconnects survive IP changes. Eliminating
that dependency requires separately hosting and configuring iroh DNS discovery
for both endpoints.
