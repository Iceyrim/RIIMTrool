# Synthetic dashboard preview

The optional multi-runner sidecar is started with `npm run dashboard:sidecar` and is fixed to
`127.0.0.1:4400`. Existing embedded dashboards and their ports are unchanged. Runners publish
atomic, read-only per-session files under `/var/lib/riim-dashboard/state/dashboard/snapshots`; the
newest 20 files per venue/mode are retained. Explicitly stopped sessions remain viewable until superseded, while two
simultaneously fresh running sessions for one venue/mode are reported as a conflict.

This preview serves deterministic, in-memory sample data. It does not load configuration, connect
to adapters or exchanges, read credentials, inspect live state, or expose trading controls.

## Start and stop

On the dashboard host, run `npm run dashboard:preview` (default port `4200`) or choose a port with
`npm run dashboard:preview -- --port 4200`. The listener is fixed to `127.0.0.1`; other bind
addresses are rejected. Stop it with Ctrl-C.

Check liveness with `curl http://127.0.0.1:4200/healthz` and readiness with
`curl http://127.0.0.1:4200/readyz`. These endpoints return only a status word and no trading data.

## View through SSH

From the operator workstation, run exactly:

```sh
ssh -N -L 8080:127.0.0.1:4200 <user>@<server>
```

Then open `http://127.0.0.1:8080`. Keep the SSH command running while viewing the dashboard.

If port 8080 is occupied locally, choose another local port in the first `8080` position. If the
preview is started on another remote port, use that same port in the tunnel destination.
