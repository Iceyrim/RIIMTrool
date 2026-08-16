# Dashboard sidecar systemd deployment

This is an operator-run deployment recipe. The repository does not install, enable, or start the
unit. The sidecar is read-only and its listener is fixed in code to `127.0.0.1:4400`; routing and
Tailscale configuration are deliberately outside this procedure.

Build the artifact with `sh deploy/build-dashboard-sidecar-artifact.sh`. The builder bundles only its
exact source allowlist, copies only `dashboard.html`, and fails if another imported source or output
file appears. Install those two generated files under `/opt/riim-dashboard` and install
`deploy/systemd/riim-dashboard.service` through the host's normal configuration-management process.

Provision ownership before starting anything:

```sh
install -d -o riim-dashboard -g riim-dashboard -m 2750 /opt/riim-dashboard
install -d -o riim-dashboard -g riim-dashboard -m 2770 /var/lib/riim-dashboard
install -d -o riim-dashboard -g riim-dashboard -m 2770 /var/lib/riim-dashboard/state
install -d -o riim-dashboard -g riim-dashboard -m 2770 /var/lib/riim-dashboard/state/dashboard
install -d -o riim-dashboard -g riim-dashboard -m 2770 /var/lib/riim-dashboard/state/dashboard/snapshots
```

Every writable directory is setgid, so new directories and snapshot files inherit the
`riim-dashboard` group. The publisher forces snapshot mode `0640`; the unit also applies
`UMask=0027`. `/opt/riim-dashboard` must contain only the two allowlisted artifact files.

Runners publish directly to `/var/lib/riim-dashboard/state/dashboard/snapshots`; the sidecar reads
that same fixed path. The unit confines the path with `ReadOnlyPaths`, so the sidecar cannot alter
runner snapshots. No path mapping is required. Daemon reloads, enable/start/restart commands, proxy
routes, and Tailscale changes are intentionally not performed or prescribed here. Restart policy
applies only to `riim-dashboard.service`; it has no dependency on any trading unit.
