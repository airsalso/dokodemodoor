# 20260209 Prompt Review (Pre-recon -> Recon -> Recon-Verify -> API Fuzzer)

## Scope
Runtime prompt snapshots from `audit-logs/172-20-208-1_a3851221-21a5-4054-bc71-e0a1d79fd2e3/prompts/` reviewed in execution order:
- `pre-recon.md`
- `login-check.md`
- `recon.md`
- `recon-verify.md`
- `api-fuzzer.md`

---

## pre-recon.md
**Strengths**
- Clear priority/precedence rules and external-attacker perspective.
- “Code is ground truth” with file:line grounding.
- Repo path constraints are explicit (reduces path drift).

**Risks / Issues**
- SECURITY_CONTEXT (OSV/Semgrep) is very large, can dilute focus for smaller models.
- Discovery guidance is constrained but does not explicitly allow minimal `rg --files` usage, which can slow practical discovery.
- Deliverable expectations are implied more than reinforced in this step.

**Net**: Solid base, but context is heavy and can overwhelm small models.

---

## login-check.md
**Strengths**
- Task scope is extremely narrow and well enforced (Playwright-first).
- Anti-hallucination and one-action-per-turn rules prevent tool drift.
- Explicit success/failure verification and evidence capture steps.

**Risks / Issues**
- Instruction density is very high; small models may miss key steps.
- Auth session extraction requirement is heavy (cookies + storage + headers), often unreliable with small models.
- Bash + Playwright snapshot requirements can conflict or add failure points.

**Net**: Effective but too verbose; a lightweight variant would likely be more reliable for smaller models.

---

## recon.md
**Strengths**
- Clear recon objectives and outputs for downstream agents.
- Pre-recon is treated as authoritative baseline (reduces duplication).
- Scope + focus/avoid rules are practical for real-world use.

**Risks / Issues**
- Full login instructions are repeated, which can distract from recon goals.
- “TaskAgent only” for code access is strict; simple `open_file` use is sometimes enough.
- Many required deliverables without explicit prioritization; risky under time limits.

**Net**: Well-structured but heavy; login instructions are over-inserted.

---

## recon-verify.md
**Strengths**
- Explicit category header format for 8 vuln classes ensures downstream parsing stability.
- Path correction requirement improves fidelity.
- Recon-trust + limited discovery rule is good for cost control.

**Risks / Issues**
- Overly absolute language (“zero omissions”, “fatal error”) can backfire on small models.
- SECURITY_CONTEXT block is huge and competes with verification focus.
- Conflicting guidance: “don’t verify with ls/cat” vs “verify every path”.
- Save logic conflicts: “save_deliverable only” vs “use bash if big”.

**Net**: Correct intent, but overconstrained; high risk of failure for smaller models.

---

## api-fuzzer.md
**Strengths**
- Recon content is fully inlined, so endpoints are available without extra reads.
- Includes endpoint inventory and input vectors.

**Risks / Issues**
- Entire recon report is copied in; prompt is too long for a fuzzing task.
- Output format for API_FUZZ_REPORT is weakly specified.
- Large token waste that reduces task focus for small models.

**Net**: Needs heavy condensation into a structured “fuzzing input list”.

---

## Overall Themes (Pre-recon -> Recon)
- **Context Overload**: SECURITY_CONTEXT and recon inlining are too large for smaller models.
- **Instruction Density**: Several prompts are excessively verbose; increases drift risk.
- **Conflicting Rules**: Some prompts contain contradictory guidance on tooling/verification.

---

## Next Steps (Proposed)
1. Trim SECURITY_CONTEXT usage to a short “hotspot summary” for small models.
2. Move login instructions out of recon prompt or compress into a single pointer.
3. Define a minimal, strict output template for API Fuzzer results.
4. Relax absolute language in recon-verify while keeping category structure.

