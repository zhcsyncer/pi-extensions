# Upstream source

Selected `/btw` behavior and private payload/mailbox implementation patterns in this package were adapted from:

- Package: `pi-herdr-btw`
- Version: `0.3.0`
- Author: Oscar Gabriel
- Repository: <https://github.com/oscabriel/pi-herdr-btw>
- npm: <https://www.npmjs.com/package/pi-herdr-btw/v/0.3.0>
- Tarball: <https://registry.npmjs.org/pi-herdr-btw/-/pi-herdr-btw-0.3.0.tgz>
- Integrity: `sha512-BexO5Ddsu5l4+XnaLMUxO6vvNljIbpQmwR+IXau0k8z44/JftrG4EjgcDsc8dTIFKqq8UlDtpC7r2Zo2AdYnEQ==`
- License: MIT (preserved in [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE))

The source was inspected from the published `pi-herdr-btw@0.3.0` npm tarball. It is not a runtime dependency.

The companion implementation was reorganized around separate process and BTW state machines and adds request-tagged custom-message session evidence, single-owner dispatch-lease recovery, uniquely named ticket-candidate locks, lock-serialized first-session binding, conservative agent-resolved stale cleanup, explicit-ID-only launch-failure cleanup, socket-scoped state roots, and integration with the package's runtime and generic blocked modules.
