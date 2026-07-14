import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CONDITIONS,
  DOMAINS,
  SOURCES,
  PROVENANCE,
  evidenceFor,
  supportsFor,
  byId,
} from "./evidence.js";
import { screen, triageScreen, higher, RUNGS, TRIAGE, ALWAYS_VISIBLE } from "./redflags.js";
import { answer, isConfigured } from "./assistant.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(__dirname, "../public")));

// The deployed app is public and /api/ask spends real money on a personal API key.
// Gate that endpoint and only that one — browsing the library, the red-flag rail and
// the questions list all stay open, so a fumbled code can never dead-end a patient (or
// a demo). If ACCESS_CODE is unset (local dev) the gate is a no-op.
const ACCESS_CODE = process.env.ACCESS_CODE || "";

function requireCode(req, res, next) {
  if (!ACCESS_CODE) return next();
  if (req.get("x-access-code") === ACCESS_CODE) return next();
  res.status(401).json({
    error: "Access code required to ask a question. You can still browse the library.",
    needsCode: true,
  });
}

app.get("/api/config", (req, res) => {
  res.json({
    assistantAvailable: isConfigured(),
    codeRequired: Boolean(ACCESS_CODE),
    conditions: CONDITIONS,
    domains: DOMAINS,
    sources: SOURCES,
    provenance: PROVENANCE,
    rungs: RUNGS,
    triage: TRIAGE,
    redFlags: ALWAYS_VISIBLE,
  });
});

app.post("/api/unlock", requireCode, (req, res) => res.json({ ok: true }));

// The library. Deterministic, instant, no API key required. This endpoint is the one
// that must never break — with the model switched off entirely, a patient can still
// browse every card and every support service, which is most of the value.
app.get("/api/library/:condition", (req, res) => {
  const { condition } = req.params;
  if (!CONDITIONS[condition]) return res.status(404).json({ error: "Unknown condition." });
  res.json({
    condition: CONDITIONS[condition],
    evidence: evidenceFor(condition),
    supports: supportsFor(condition),
  });
});

// THE RAIL. Two guarantees are enforced here, in code, rather than requested in a
// prompt — because a prompt is a request and code is a guarantee.
//
//   1. The model can escalate but never soften. The deterministic red-flag screen runs
//      FIRST and sets a floor; the final disposition is max(floor, model). A hot swollen
//      joint with a fever goes to ED even if the model is busy answering a question
//      about beer.
//
//   2. The model cannot invent advice. Every card ID it returns is checked against the
//      library for this condition, and anything it made up is dropped. If nothing
//      survives, the answer is not shown as guidance at all — it is parked on the
//      questions list instead. The failure mode is "we don't know", never a confident
//      fabrication.
app.post("/api/ask", requireCode, async (req, res) => {
  const question = req.body?.question?.trim();
  const condition = req.body?.condition;

  if (!question) return res.status(400).json({ error: "No question supplied." });
  if (!CONDITIONS[condition]) return res.status(400).json({ error: "Unknown condition." });

  // Two independent screens, both deterministic, both running before the model and with
  // or without an API key:
  //
  //   screen()       — patterns over what they typed
  //   triageScreen() — the three questions we ASKED them, because what they typed
  //                    cannot be relied on. "Shivery" is not "fever", and the person
  //                    who does not know which word matters is exactly the person this
  //                    has to catch.
  //
  // The floor is the higher of the two.
  const typed = screen({ condition, question });
  const asked = triageScreen(req.body?.triage);
  const floor = higher(typed.floor, asked.floor);
  const flags = [...asked.flags, ...typed.flags];

  // THE SHORT CIRCUIT. If the deterministic screens say this person needs to be seen
  // tonight, we answer instantly and we do not call the model at all.
  //
  // Three reasons, in order of importance. It cannot be delayed by a slow model on 4G
  // at 2am. It cannot be softened, reworded, or buried under lifestyle advice by a
  // model that misjudges the room. And it cannot fail because an API key expired or a
  // bill went unpaid. The most dangerous path in this product is the one with the
  // fewest moving parts, and no language model anywhere near it.
  if (floor === "ED") {
    return res.json({
      question,
      grounded: false,
      redFlagOnly: true,
      disposition: "ED",
      rung: RUNGS.ED,
      flags,
      evidence: [],
      // Still worth capturing — they will want to tell someone what happened.
      gpQuestion: `[Flare on ${new Date().toLocaleDateString("en-AU")}] ${question}`,
      parked: true,
    });
  }

  if (!isConfigured()) {
    return res.status(503).json({
      error: "No ANTHROPIC_API_KEY set — question answering is unavailable. Browse the library instead.",
      screen: { floor, flags },
    });
  }

  const cards = evidenceFor(condition);

  try {
    const raw = await answer({
      question,
      condition,
      conditionLabel: CONDITIONS[condition].label,
      cards,
      screen: { floor, flags },
    });

    // Guarantee 2: drop every card the model invented.
    const cited = (raw.evidenceIds || [])
      .map(byId)
      .filter((c) => c && (c.condition === condition || c.condition === "*"));

    const grounded = cited.length > 0 && raw.answerable;

    // Guarantee 1: the rule engine's floor wins. The model may raise the disposition,
    // never lower it.
    const disposition = higher(floor, raw.disposition || "SELF_MANAGE");

    res.json({
      question,
      grounded,
      framing: raw.framing,
      unansweredReason: raw.unansweredReason,
      evidence: cited,
      disposition,
      rung: RUNGS[disposition],
      // Said in words, not staged as an animation. An unexplained escalation gets
      // ignored; an explained one gets acted on.
      raisedByRule: raw.disposition && higher(floor, raw.disposition) !== raw.disposition,
      modelSaid: raw.disposition ? RUNGS[raw.disposition]?.label : null,
      flags,
      gpQuestion: raw.gpQuestion,
      // Anything the library could not answer does not evaporate — it becomes the thing
      // they walk in with. That is the whole point of a six-month wait.
      parked: !grounded,
    });
  } catch (err) {
    console.error("ask failed:", err);
    res.status(502).json({ error: `Could not answer that: ${err.message}`, screen: { floor, flags } });
  }
});

const PORT = process.env.PORT || 5070;
app.listen(PORT, () => {
  console.log(`\n  Co-Motion  →  http://localhost:${PORT}`);
  console.log(
    isConfigured()
      ? "  Question answering: enabled (claude-opus-4-8)\n"
      : "  Question answering: DISABLED (no ANTHROPIC_API_KEY) — library + red-flag rail still work\n",
  );
});
