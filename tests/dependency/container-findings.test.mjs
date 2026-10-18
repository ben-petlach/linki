import assert from "node:assert/strict";
import { test } from "node:test";
import { assess } from "../../scripts/check-container-findings.mjs";

const finding = { VulnerabilityID: "CVE-test", PkgName: "libtest", InstalledVersion: "1", Severity: "HIGH" };
const report = (patch = {}) => ({ Metadata: { OS: { Family: "debian", Name: "13.7" } }, Results: [{ Class: "os-pkgs", Vulnerabilities: [{ ...finding, ...patch }] }] });
const policy = { expires: "2026-11-01T00:00:00Z", exceptions: [{ id: "CVE-test", package: "libtest", version: "1", severity: "HIGH", reason: "entry point absent", source: "https://security-tracker.debian.org/" }] };
const now = new Date("2026-10-18T00:00:00Z");

test("only exact reviewed OS findings pass, with raw evidence retained", () => {
  const input = report();
  assert.equal(assess(input, policy, now).accepted.length, 1);
  assert.equal(input.Results[0].Vulnerabilities.length, 1);
  for (const patch of [{ VulnerabilityID: "CVE-new" }, { PkgName: "other" }, { InstalledVersion: "2" }, { Severity: "CRITICAL" }, { FixedVersion: "2" }]) {
    assert.equal(assess(report(patch), policy, now).blocked.length, 1);
  }
  input.Results[0].Class = "lang-pkgs";
  input.Results.push({ Class: "os-pkgs", Vulnerabilities: [] });
  assert.equal(assess(input, policy, now).blocked.length, 1);
});

test("expired assessments and missing or changed OS evidence fail closed", () => {
  assert.throws(() => assess(report(), policy, new Date(policy.expires)), /expired/);
  assert.throws(() => assess({ Results: [] }, policy, now), /OS/);
  const input = report();
  input.Metadata.OS.EOSL = true;
  assert.throws(() => assess(input, policy, now), /unsupported/);
  input.Metadata.OS.EOSL = false;
  input.Results = [];
  assert.throws(() => assess(input, policy, now), /Missing/);
});
