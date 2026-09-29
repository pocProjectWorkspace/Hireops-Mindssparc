/**
 * ASR keyterms — pure tests, no database.
 *
 * The interview's own names (employer, candidate, panel, role) are sent to
 * AssemblyAI as `keyterms_prompt` so proper nouns come back spelled the way
 * the business spells them. These pin the list shape and the vendor limits.
 */

import "../src/bootstrap";
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { normaliseKeyterms } from "@hireops/ai-client";
import { buildInterviewKeyterms } from "../../../apps/workers/src/lib/asr-keyterms.js";

describe("asr keyterms", () => {
  it("builds whole names plus their parts, company first", () => {
    const terms = buildInterviewKeyterms({
      tenantDisplayName: "Solenis GBS India",
      candidateName: "Karthik Subramanian",
      panelNames: ["Maneesh Gupta", null, "Raghu Mehra"],
      positionTitle: "SAP Plant Accountant",
    });
    assert.equal(terms[0], "Solenis GBS India");
    for (const t of [
      "Solenis",
      "GBS",
      "Karthik Subramanian",
      "Karthik",
      "Maneesh",
      "Raghu",
      "Mehra",
    ]) {
      assert.ok(terms.includes(t), `missing ${t}`);
    }
    assert.ok(terms.includes("SAP Plant Accountant"));
    assert.ok(!terms.includes(""), "no empty terms");
  });

  it("tolerates a missing context without inventing terms", () => {
    assert.deepEqual(
      buildInterviewKeyterms({
        tenantDisplayName: null,
        candidateName: "  ",
        panelNames: [],
        positionTitle: null,
      }),
      [],
    );
  });

  it("normalises to the vendor limits: trimmed, de-duplicated, <= 6 words, capped", () => {
    const out = normaliseKeyterms([
      "  Solenis  ",
      "solenis",
      "",
      "one two three four five six seven",
      "x".repeat(61),
      ...Array.from({ length: 150 }, (_, i) => `Term${i}`),
    ]);
    assert.equal(out[0], "Solenis");
    assert.equal(out.filter((t) => t.toLowerCase() === "solenis").length, 1);
    assert.ok(!out.includes("one two three four five six seven"));
    assert.ok(out.every((t) => t.length <= 60));
    assert.equal(out.length, 100);
    assert.deepEqual(normaliseKeyterms(undefined), []);
  });
});
