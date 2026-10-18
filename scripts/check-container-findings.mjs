import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function assess(report, policy, now = new Date()) {
  if (report.Metadata?.OS?.Family !== "debian" || report.Metadata.OS.Name !== "13.7" || report.Metadata.OS.EOSL) {
    throw new Error("Unreviewed or unsupported container OS");
  }
  if (!Array.isArray(report.Results) || !report.Results.some(result => result.Class === "os-pkgs")) {
    throw new Error("Missing OS scan results");
  }
  const expires = Date.parse(policy.expires);
  if (!Number.isFinite(expires) || now.getTime() >= expires) throw new Error("Container assessment expired");
  const accepted = [], blocked = [];
  for (const result of report.Results) {
    for (const finding of result.Vulnerabilities ?? []) {
      if (!["HIGH", "CRITICAL"].includes(finding.Severity)) continue;
      const exception = policy.exceptions.find(entry =>
        result.Class === "os-pkgs" && entry.severity === finding.Severity && !finding.FixedVersion &&
        entry.id === finding.VulnerabilityID && entry.package === finding.PkgName &&
        entry.version === finding.InstalledVersion && entry.reason && entry.source);
      (exception ? accepted : blocked).push({ id: finding.VulnerabilityID, package: finding.PkgName, version: finding.InstalledVersion });
    }
  }
  return { accepted, blocked };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reportPath, policyPath] = process.argv.slice(2);
  const result = assess(JSON.parse(readFileSync(reportPath, "utf8")), JSON.parse(readFileSync(policyPath, "utf8")));
  console.log(JSON.stringify(result, null, 2));
  if (result.blocked.length) process.exitCode = 1;
}
