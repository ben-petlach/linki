import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { evaluateEligibility, initSuppressionSchema, preserveCompanySuppressionOnDelete, preserveTargetSuppressionOnDelete, suppressIdentity, suppressTarget } from "../../lib/reliability/suppression";
import { importCsv } from "../../lib/csv-import";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE companies (id TEXT PRIMARY KEY, domain TEXT);
    CREATE TABLE targets (id TEXT PRIMARY KEY, linkedin_url TEXT UNIQUE, email TEXT, company_id TEXT,
      full_name TEXT, first_name TEXT, last_name TEXT, title TEXT, company TEXT, location TEXT,
      city TEXT, country TEXT, phone TEXT, headline TEXT, summary TEXT, notes TEXT, sales_nav_url TEXT,
      message_sent_at TEXT, inmail_sent_at TEXT, connection_requested_at TEXT, last_replied_at TEXT, email_replied_at TEXT);
    CREATE TABLE list_targets (list_id TEXT, target_id TEXT, UNIQUE(list_id, target_id));
    INSERT INTO companies VALUES ('c1', 'Example.com'), ('c2', 'other.com');
    INSERT INTO targets (id, linkedin_url, email, company_id, full_name) VALUES
      ('t1', 'https://www.linkedin.com/in/jane', 'Jane@Example.com', 'c1', 'Jane Smith'),
      ('t2', 'https://www.linkedin.com/in/john', 'john@example.com', 'c1', 'John Smith'),
      ('t3', 'https://www.linkedin.com/in/jane-smith', 'jane@other.com', 'c2', 'Jane Smith');
  `);
  initSuppressionSchema(db);
  return db;
}

test("person reply blocks exact person across channels and persists after deletion/reimport", () => {
  const db = fixture();
  suppressTarget(db, "t1", "inbound_reply", "message-1");
  suppressTarget(db, "t1", "inbound_reply", "message-1");
  assert.equal(evaluateEligibility(db, "t1", { channel: "email" }).allowed, false);
  assert.equal(evaluateEligibility(db, "t1", { channel: "linkedin" }).allowed, false);
  assert.equal(evaluateEligibility(db, "t2").allowed, true);
  assert.equal(evaluateEligibility(db, "t3").allowed, true); // same name is never an identity key
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM suppression_rules").get() as { n: number }).n, 3);
  db.prepare("DELETE FROM targets WHERE id = 't1'").run();
  db.prepare(`INSERT INTO targets (id, email, linkedin_url, company_id) VALUES
    ('t4', 'jane@example.com', 'https://www.linkedin.com/in/jane/', 'c1')`).run();
  const verdict = evaluateEligibility(db, "t4");
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.blocks.some((b) => b.reason === "inbound_reply" && b.evidence === "message-1"));
  db.close();
});

test("company exclusions apply across contacts; sourced-only remains eligible for net-new", () => {
  const db = fixture();
  suppressIdentity(db, { kind: "company_domain", value: "EXAMPLE.COM", reason: "previously_contacted", scope: "net_new", evidence: "crm-42" });
  assert.equal(evaluateEligibility(db, "t1", { netNew: true }).allowed, false);
  assert.equal(evaluateEligibility(db, "t2", { netNew: true }).allowed, false);
  assert.equal(evaluateEligibility(db, "t3", { netNew: true }).allowed, true);
  assert.equal(evaluateEligibility(db, "t1", { netNew: false }).allowed, true);
  assert.equal(evaluateEligibility(db, "t2", { netNew: true }).blocks[0].evidence, "crm-42");
  db.close();
});

test("hard bounce blocks email address, not LinkedIn or company; unsubscribe survives CSV reimport", () => {
  const db = fixture();
  suppressIdentity(db, { kind: "email", value: "Jane@Example.com", reason: "hard_bounce", evidence: "smtp-550" });
  assert.equal(evaluateEligibility(db, "t1", { channel: "email" }).allowed, false);
  assert.equal(evaluateEligibility(db, "t1", { channel: "linkedin" }).allowed, true);
  assert.equal(evaluateEligibility(db, "t2", { channel: "email" }).allowed, true);
  suppressIdentity(db, { kind: "email", value: "jane@example.com", reason: "unsubscribe", evidence: "list-unsub-1" });
  const csv = "linkedin_url,email,first_name,last_name\nhttps://www.linkedin.com/in/jane/,jane@example.com,Jane,Smith\n";
  const result = importCsv(db, "list-1", csv);
  assert.equal(result.errors.length, 0);
  assert.equal(evaluateEligibility(db, "t1", { channel: "email" }).allowed, false);
  db.close();
});

test("CSV refuses conflicting exact identifiers and never merges by matching name", () => {
  const db = fixture();
  const csv = "linkedin_url,email,first_name,last_name\nhttps://www.linkedin.com/in/jane/,john@example.com,Jane,Smith\nhttps://www.linkedin.com/in/another/,jane@example.com,Jane,Smith\nhttps://www.linkedin.com/in/new/,new@other.com,Jane,Smith\n";
  const result = importCsv(db, "list-1", csv);
  assert.equal(result.errors.length, 2);
  assert.equal(result.imported, 1);
  assert.equal(evaluateEligibility(db, "t3").allowed, true);
  db.close();
});

test("deleting contacted person preserves net-new exclusion, but sourced-only deletion does not", () => {
  const db = fixture();
  db.prepare("UPDATE targets SET message_sent_at = '2026-01-01' WHERE id = 't1'").run();
  preserveTargetSuppressionOnDelete(db, "t1");
  preserveTargetSuppressionOnDelete(db, "t3");
  db.prepare("DELETE FROM targets WHERE id IN ('t1', 't3')").run();
  db.prepare(`INSERT INTO targets (id, email, linkedin_url) VALUES
    ('reimported1', 'jane@example.com', 'https://www.linkedin.com/in/jane'),
    ('reimported3', 'jane@other.com', 'https://www.linkedin.com/in/jane-smith')`).run();
  assert.equal(evaluateEligibility(db, "reimported1", { netNew: true }).allowed, false);
  assert.equal(evaluateEligibility(db, "reimported3", { netNew: true }).allowed, true);
  db.close();
});

test("deleting a suppressed company preserves its existing contacts' exclusions", () => {
  const db = fixture();
  suppressIdentity(db, { kind: "company", value: "c1", reason: "excluded_company", evidence: "crm-company" });
  preserveCompanySuppressionOnDelete(db, "c1");
  db.prepare("UPDATE targets SET company_id = NULL WHERE company_id = 'c1'").run();
  db.prepare("DELETE FROM companies WHERE id = 'c1'").run();
  assert.equal(evaluateEligibility(db, "t1").allowed, false);
  assert.equal(evaluateEligibility(db, "t2").allowed, false);
  assert.equal(evaluateEligibility(db, "t3").allowed, true);
  db.close();
});
