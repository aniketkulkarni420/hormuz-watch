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
