# Pre-Recon / Recon / Recon-Verify Review (2026-02-09)

## Overview
Current deliverables are **format-compliant but accuracy-deficient**. The most serious issue is **incorrect file paths and misclassified sinks**, which propagate from pre-recon into recon and then get “verified” without correction.

---

## 1) pre_recon_deliverable.md

### Strengths
- Structure follows the updated prompt.
- Includes the required sections and coverage declarations.
- “None found” appears where expected (at least structurally).

### Critical Problems
- **Incorrect or unverifiable file paths**:
  - References like `routes/products.ts`, `routes/reviews.ts`, `routes/profile.ts`, `routes/user.ts` do not match the real Juice-Shop code layout (likely `routes/search.ts`, `routes/productReviews.ts`, `routes/profileImage*.ts`, etc.).
- **Misplaced security components**:
  - `security.isAuthorized()` attributed to `routes/security.ts`, but in Juice-Shop it lives under `lib/insecurity.ts`.
- **XSS reasoning is weak / incorrect**:
  - JSON-returning endpoints (e.g., `/rest/user/authentication-details`) do **not** imply XSS.
  - Angular templates generally escape by default; need concrete sink evidence.

### Result
Pre-recon acts as a rough map, but **its evidence quality is too low to trust** downstream.

---

## 2) recon_deliverable.md

### Strengths
- Output format and anchors are respected.
- Attack surface list is detailed and structured.

### Critical Problems
- **Multiple incorrect file paths / fake line references**:
  - Same incorrect `routes/*.ts` files reused.
  - Example: `routes/web3.ts` referenced with `child_process.exec`, but file not found.
- **Misclassification**:
  - SSRF and CODEI are mixed (e.g., exec usage claimed without actual file evidence).
- **Authorization/IDOR findings appear inferred**:
  - Many IDOR claims lack a verified guard check.

### Result
The recon report is **not reliable** as an authoritative map because it contains invented or mismatched code references.

---

## 3) recon_verify_deliverable.md

### Strengths
- Uses **UNTESTABLE** labels when files are missing.

### Critical Problems
- **No path correction performed**:
  - Missing files (`routes/reviews.ts`, `routes/web3.ts`) are just marked untestable, not corrected.
- **Verification doesn’t add evidence**:
  - It mostly repeats recon references.

### Result
Recon-verify is failing its purpose. It should **correct invalid references** and re-anchor them to real files.

---

## Root Cause Pattern
1) pre-recon invents / mislabels files
2) recon copies them
3) recon-verify marks them untestable rather than correcting

This causes **systematic drift** and wastes downstream agent time.

---

## Minimum Fix Required

1. **Pre-recon must only cite verified files/lines**
   - If a path can’t be confirmed, it must be marked `Unverified` or `None found`.

2. **Recon must prefer verified paths**
   - No mapping should use files that don’t exist.

3. **Recon-verify must correct paths**
   - If a file is missing, it must locate the correct file and update the overlay.

4. **Classification rules must be stricter**
   - XSS only when evidence shows unsafe rendering.
   - CODEI only when actual eval/exec is present.
   - SSRF when outbound HTTP fetch is user-controlled.

---

## Recommended Next Steps
- Strengthen recon + recon-verify prompts to **enforce path correction** (not just UNTESTABLE).
- Add explicit “**file existence check required**” rule before listing any sink.
- Re-run pre-recon, recon, recon-verify after those changes.

