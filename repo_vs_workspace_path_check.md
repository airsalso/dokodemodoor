**Repo vs Workspace Path Check**

**Goal**
Enforce strict sandboxing to `{{REPO_PATH}}` only. The system must not operate on or assume the workspace root for any path resolution.

**Summary**
- `list_files` now resolves all relative paths against `{{REPO_PATH}}` and **blocks traversal outside** the repo root.
- Shared path guidance updated to treat `{{REPO_PATH}}` as the **only** allowed root.
- Prompt references to workspace-level paths were removed or redirected to `deliverables/` under `{{REPO_PATH}}`.

**Key Changes (Completed)**
1. **list_files sandboxed to repo root**
   - Enforces `path` under `{{REPO_PATH}}` and rejects any external path.
   - Relative paths now resolve against `{{REPO_PATH}}`, not the workspace CWD.
   - File exclusion list adjusted to allow `deliverables/` discovery.

2. **Shared path guidance tightened**
   - `prompts-openai/shared/_path-awareness.txt` now:
     - Treats `{{REPO_PATH}}` as the repository root.
     - Removes fallback to `pwd` for root inference.
     - Instructs STOP if `{{REPO_PATH}}` is missing.

3. **Prompt cleanup of workspace references**
   - Removed `workspace/*_false_positives.md` references.
   - Updated auth exploit scratch output to `deliverables/_scratch/...`.
   - Updated api-fuzzer guidance to reference `{{REPO_PATH}}` explicitly.

**Potentially Affected Areas (Verified)**
- Prompts that mention “project root” now map to `{{REPO_PATH}}`.
- `list_files` searches now **only** cover repo content; any attempt to search workspace will error.

**Files Modified**
- `mcp-server/src/tools/list-files.js`
- `prompts-openai/shared/_path-awareness.txt`
- `prompts-openai/api-fuzzer.txt`
- `prompts-openai/exploit-auth.txt`
- `prompts-openai/exploit-xss.txt`
- `prompts-openai/exploit-ssrf.txt`

**Remaining References**
- `prompts-openai/osv-analysis.txt` contains “Project Root: {{REPO_PATH}}” which is compliant.

**Operational Guidance**
- Always pass repo-relative paths or `{{REPO_PATH}}`-anchored paths in tool calls.
- For any file discovery, call:
  - `list_files({"path":"deliverables","query":"..."} )` or
  - `list_files({"path":".","query":"..."} )` (implicitly within `{{REPO_PATH}}`).

**Conclusion**
The system now enforces a repo-only sandbox. Any tool or prompt that attempts to operate outside `{{REPO_PATH}}` will be blocked or should be corrected.
