// PAT diagnostic endpoint — answers "is GH_REFRESH_PAT in CF env valid?"
//
// Calls GitHub's /user endpoint with the stored PAT. Returns:
//   - pat_present, pat_length, pat_prefix (first 11 chars only — always
//     "github_pat_" if user pasted correctly), pat_last4 (low-risk tail)
//   - github_response_status (200 = PAT valid · 401 = bad/revoked/expired)
//   - github_user_login when valid, error body when not
//
// No token bytes are leaked — only shape + GitHub's own verdict.
//
// Usage: curl https://hormuz-watch-2.pages.dev/api/admin/pat-diag

export async function onRequest({ env }) {
  const pat = env.GH_REFRESH_PAT || "";

  const out = {
    pat_present: !!pat,
    pat_length: pat.length,
    pat_starts_with_github_pat_: pat.startsWith("github_pat_"),
    pat_first_11: pat.slice(0, 11),     // safe — should be "github_pat_"
    pat_last4: pat.slice(-4),            // low risk — last 4 chars only
    pat_has_whitespace: pat !== pat.trim(),
  };

  if (!pat) {
    return _json({ ...out, hint: "CF env var GH_REFRESH_PAT is missing/empty. Add in Pages → Settings → Environment variables → Production." });
  }

  // Ask GitHub directly — most authoritative answer.
  try {
    const r = await fetch("https://api.github.com/user", {
      headers: {
        "Authorization": `Bearer ${pat.trim()}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "hormuz-watch-pat-diag/1.0",
      },
    });
    out.github_response_status = r.status;
    if (r.status === 200) {
      try {
        const u = await r.json();
        out.github_user_login = u.login;
        out.github_user_id = u.id;
        out.verdict = "PAT_VALID";
        out.next_step = "PAT works. If /api/admin/refresh still fails, the PAT lacks 'Actions: read+write' scope on the hormuz-watch repo. Regenerate with that scope.";
      } catch {
        out.verdict = "PAT_VALID_PARSE_ERR";
      }
    } else if (r.status === 401) {
      let body = "";
      try { body = await r.text(); } catch {}
      out.github_error_body = body.slice(0, 200);
      out.verdict = "PAT_INVALID";
      out.next_step = "GitHub does not recognize this token. Causes: (1) PAT was revoked, (2) PAT expired, (3) PAT bytes corrupted on paste into CF, (4) CF env var still holds an older revoked PAT (not what you intended).";
    } else {
      // Fallthrough → other status
    }

    // ── Probe 2: can this PAT see the repo? ─────────────────────────────
    // Fine-grained PATs sometimes authenticate (/user works) but the
    // "Only select repositories" list was left empty during creation —
    // in which case GET /repos/<owner>/<repo> returns 404.
    if (out.verdict === "PAT_VALID") {
      try {
        const rr = await fetch("https://api.github.com/repos/aniketkulkarni420/hormuz-watch", {
          headers: {
            "Authorization": `Bearer ${pat.trim()}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "hormuz-watch-pat-diag/1.0",
          },
        });
        out.repo_access_status = rr.status;
        if (rr.status !== 200) {
          let body = "";
          try { body = await rr.text(); } catch {}
          out.repo_error_body = body.slice(0, 200);
          out.verdict = "PAT_VALID_BUT_NO_REPO_ACCESS";
          out.next_step = "PAT authenticates with GitHub but cannot see aniketkulkarni420/hormuz-watch. Cause: 'Only select repositories' list was empty, OR hormuz-watch was NOT ticked, when generating the PAT. Regenerate the PAT and explicitly tick the hormuz-watch checkbox in 'Repository access'.";
        }
      } catch (e) {
        out.repo_probe_error = String(e).slice(0, 160);
      }
    }

    // ── Probe 3: can this PAT dispatch a workflow? ───────────────────────
    // Tries POST .../actions/workflows/<bdti>/dispatches (BDTI is daily,
    // safe to ping). 204 = success. 403 = scope missing. 404 = no access.
    if (out.verdict === "PAT_VALID") {
      try {
        const dr = await fetch("https://api.github.com/repos/aniketkulkarni420/hormuz-watch/actions/workflows/bdti-weekly.yml/dispatches", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${pat.trim()}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "hormuz-watch-pat-diag/1.0",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: "main" }),
        });
        out.dispatch_test_status = dr.status;
        if (dr.status === 204) {
          out.verdict = "PAT_FULLY_WORKING";
          out.next_step = "PAT can dispatch workflows. /api/admin/refresh should work now. If it still fails, run it again and paste the response.";
        } else {
          let body = "";
          try { body = await dr.text(); } catch {}
          out.dispatch_error_body = body.slice(0, 200);
          if (dr.status === 403) {
            out.verdict = "PAT_LACKS_ACTIONS_WRITE";
            out.next_step = "PAT can see the repo but cannot dispatch workflows. The 'Actions' permission was set to 'Read' or 'No access'. Regenerate the PAT with Actions: 'Read and write'.";
          } else if (dr.status === 404) {
            out.verdict = "PAT_REPO_404";
            out.next_step = "Dispatch endpoint returned 404. PAT lacks repo access OR the workflow file path is wrong.";
          } else if (dr.status === 401) {
            out.verdict = "PAT_INCONSISTENT_AUTH";
            out.next_step = "PAT authenticates on /user but fails 401 on workflow_dispatch — possibly a propagation lag inside GitHub right after PAT creation. Wait 60s and re-run this diag.";
          }
        }
      } catch (e) {
        out.dispatch_probe_error = String(e).slice(0, 160);
      }
    }

    if (out.verdict === "PAT_VALID") {
      // Reached if all probes passed but verdict didn't get upgraded
      out.verdict = "PAT_VALID_PROBES_OK";
    }

    // Sentinel kept for backward compat of GitHub status fallthrough
    if (!out.verdict) {
      let body = "";
      try { body = await r.text(); } catch {}
      out.github_error_body = body.slice(0, 200);
      out.verdict = "UNEXPECTED_STATUS";
    }
  } catch (e) {
    out.verdict = "FETCH_FAILED";
    out.error = String(e).slice(0, 200);
  }

  return _json(out);
}

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
