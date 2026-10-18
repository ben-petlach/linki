# Container security assessment for a controlled trial

Assessment date: October 18, 2026. Scope: single-operator, headless, isolated trial;
not a public deployment or approval to send outreach. HubSpot and provider adapters
are unchanged. No live accounts or messages were used during this assessment.

## Evidence and decision

Baseline: `0051194`, [CI run 39151497630](https://github.com/ben-petlach/linki/actions/runs/39151497630),
artifact `12145436404`. Trivy reported 57 high/critical package rows covering 20
unique CVEs. These are package/source matches, not 57 demonstrated application
exploits. The installed-package inventory and primary Debian advisories were
reviewed against application entry points.

Keep the original digest-pinned Node 22 Trixie image and current apt updates.
A Bookworm candidate was built and tested in
[run 39164145262](https://github.com/ben-petlach/linki/actions/runs/39164145262).
It removed OS libxml2 but introduced older GLib, SQLite, Expat and other findings;
it was rejected. No mixed-distribution packages or custom security backports remain.

**Decision: acceptable residual risk for the restricted controlled trial below,
not unrestricted release clearance.** The scanner still identifies vulnerable
packages. Most findings require absent services or privileged operations. The
libxml2 findings are a time-limited risk acceptance, not a non-affected claim.

OS libxml2 is pulled by `libgbm1 -> mesa-libgallium -> libllvm19 -> libxml2`.
The inspected [LLVM 19 XML consumer](https://github.com/llvm/llvm-project/blob/llvmorg-19.1.7/llvm/lib/WindowsManifest/WindowsManifestMerger.cpp)
parses Windows manifests. Linki does not merge manifests, run XML utilities,
load Python libxml2 bindings, or pass inbound message bodies to a native XML
parser. This makes direct exploitation through the intended trial workflow less
plausible; it does not prove absence of every dynamically linked call path.
The critical CVE is described as parser UAF/DoS by Debian and classified there as
a minor issue. Other XML findings include memory corruption, so severity wording
alone is not the justification. Restrict trial data/credentials and host access,
bound resource use, and revisit the exception before broader use.

The runtime drops all Linux capabilities, prohibits privilege gain, and limits
memory to 2 GiB and processes to 256. The vulnerable `infocmp` CLI is removed,
without deleting package metadata. CI checks these restrictions and absence of
vulnerable service/tool entry points in the actual image, then launches Chromium
and verifies the built app. Resource limits contain exhaustion; they do not fix
memory-corruption bugs or prevent theft of credentials inside the container.

## Baseline finding disposition

| Finding | Relevant attack path and disposition |
| --- | --- |
| [CVE-2026-6653](https://security-tracker.debian.org/tracker/CVE-2026-6653) | XML parser UAF/DoS. Debian calls it a minor issue, while scanner rates it critical. Temporary residual-risk acceptance under the restrictions below; no claim of patched or unreachable code. |
| [CVE-2026-74860](https://security-tracker.debian.org/tracker/CVE-2026-74860) | libxml2 Python bindings; no application Python binding use. Python bindings are absent and checked by image smoke. |
| [CVE-2026-86138](https://security-tracker.debian.org/tracker/CVE-2026-86138), [86139](https://security-tracker.debian.org/tracker/CVE-2026-86139), [86140](https://security-tracker.debian.org/tracker/CVE-2026-86140), [86142](https://security-tracker.debian.org/tracker/CVE-2026-86142), [86143](https://security-tracker.debian.org/tracker/CVE-2026-86143), [86144](https://security-tracker.debian.org/tracker/CVE-2026-86144) | XML dictionary, URI, validation, XPointer, output and XInclude flaws. Native reachability not fully proven. Temporary residual-risk acceptance based on the dependency/input review above and isolated trial restrictions; not a non-affected declaration. |
| [CVE-2026-76642](https://security-tracker.debian.org/tracker/CVE-2026-76642), [78408](https://security-tracker.debian.org/tracker/CVE-2026-78408), [78409](https://security-tracker.debian.org/tracker/CVE-2026-78409), [78410](https://security-tracker.debian.org/tracker/CVE-2026-78410) | Privileged mount helpers, fstab hooks or root nsenter invocation. Linki does not use these. No root runtime, capabilities, privilege gain, host namespaces or host filesystem mounts are permitted in the trial. Exact installed Trixie package versions are recorded in policy. |
| [CVE-2026-54369](https://security-tracker.debian.org/tracker/CVE-2026-54369) | ACL pathname symlink race requires privileged caller. No application ACL helper calls; non-root and no privilege gain prevent the described escalation in this configuration. |
| [CVE-2026-34980](https://security-tracker.debian.org/tracker/CVE-2026-34980), [55453](https://security-tracker.debian.org/tracker/CVE-2026-55453) | CUPS scheduler/shared print queue and IPP backend injection. Client library alone is not the vulnerable service. Assert scheduler and IPP backend absent; do not add printing. |
| [CVE-2026-16742](https://security-tracker.debian.org/tracker/CVE-2026-16742) | systemd-homed user records. Libraries alone do not run homed. Assert homed executable/package absent. |
| [CVE-2025-69720](https://security-tracker.debian.org/tracker/CVE-2025-69720) | Crafted terminal description passed to infocmp. Remove infocmp; retain package metadata and raw scanner finding. |
| [CVE-2026-88806](https://security-tracker.debian.org/tracker/CVE-2026-88806), [88807](https://security-tracker.debian.org/tracker/CVE-2026-88807) | Malicious X server responses. Headless trial has no DISPLAY, X socket, Xvfb or X server. This conclusion does not cover visible browser login or forwarded desktop sessions. |
| [CVE-2026-9538](https://security-tracker.debian.org/tracker/CVE-2026-9538) | Perl Archive::Tar processes hostile archive. Application uses no Perl archive ingestion; assert Archive::Tar module absent. |

## Exception boundaries

The machine-readable policy lists exact CVE/package/version exceptions with source
and rationale. It expires November 1, 2026 UTC. Unknown high/critical findings, available fixes, changed versions or severity, missing scan evidence, unsupported OS,
and expired policy fail the gate. Raw Trivy results remain uploaded unchanged.
Exceptions apply only after the image smoke checks pass under the restricted
runtime. A green gate means a bounded, assessed trial image, not zero vulnerabilities.

Use the checked-in Compose restrictions, localhost binding and dedicated data
volume. No Docker socket, host root mount, privileged exec, X/Wayland socket,
DISPLAY, public port, or additional service. Keep container credentials limited to
test accounts. A publicly reachable unsubscribe endpoint and production deployment
need their own exposure review before prospect use; local CI does not test those.

Chromium currently runs with `--no-sandbox`; the non-root container is the isolation
boundary, not a substitute renderer sandbox. A browser exploit could access data
and credentials available to that container. For the bounded trial, use a disposable
host/VM and test-only identities; do not put unrelated credentials or production
mailboxes there. This is an explicit residual risk, not a finding ruled unreachable.
[Playwright recommends sandboxing for untrusted browsing](https://playwright.dev/docs/docker).
The scanner does not comprehensively assess Chromium's bundled libraries. Live
LinkedIn compatibility, inbox placement and provider authentication remain untested.
