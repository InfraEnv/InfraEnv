# Security model

InfraEnv v0.1 is a local educational simulator, not a multi-tenant security
boundary. Still, it applies defense in depth to every lab session.

## Enforced by orchestration

- A unique `docker network create --internal` network connects only the runtime
  sidecar and Ubuntu sandbox. The runtime is dual-homed on a second,
  session-scoped host bridge so Docker Desktop can publish its loopback port;
  the sandbox never joins that bridge and has no public network route.
- API/UI port `8080` is published as `127.0.0.1::<random-port>`, never on all
  host interfaces.
- Both containers are read-only, non-privileged, use
  `no-new-privileges:true`, drop `ALL` Linux capabilities, and receive process,
  CPU and memory limits.
- Neither container receives the Docker socket or a host-directory bind mount.
  A per-session named volume stores only JSONL progress.
- Runtime, sandbox and browser UI use different random tokens. A UI launch
  token is single-use and becomes an HttpOnly SameSite=Strict cookie.
- The scenario allows only named fault actions. Curriculum validators are
  interpreted declarative data and cannot execute code.

## Explicit non-goals

This alpha is not intended for untrusted multi-user hosting, real credentials,
production workloads or network-facing deployment. The simulated tools must
not be used to estimate real hardware capacity or cost.

Report security issues privately to the InfraEnv maintainers before publishing
details.
