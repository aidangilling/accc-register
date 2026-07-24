// Val Town HTTP val — public "Update Now" proxy for the ACCC register.
// ---------------------------------------------------------------------------
// This tiny function lets ANY visitor trigger a data refresh without exposing a
// GitHub token in the public website. The token lives here as a Val Town secret.
//
// SETUP (once):
//   1. On GitHub, make a fine-grained token (github.com/settings/tokens?type=beta):
//        - Repository access: Only select repositories -> accc-register
//        - Permissions -> Repository -> "Actions": Read and write
//        - (Metadata: Read-only is added automatically)
//      Copy the github_pat_... value.
//   2. In Val Town (val.town), create a new HTTP val and paste this whole file.
//   3. In Val Town, add an Environment Variable named GITHUB_TOKEN = that token.
//   4. Copy the val's HTTP endpoint URL (…​.web.val.run) and paste it into
//      assets/config.js in the website, then commit.
//
// A ~3-minute cooldown stops the button being spammed. Public repos get
// unlimited free Actions minutes, and the workflow only commits when data
// actually changed, so repeated clicks are harmless.
// ---------------------------------------------------------------------------

const OWNER = "aidangilling";
const REPO = "accc-register";
const WORKFLOW = "update.yml";
const COOLDOWN_MS = 3 * 60 * 1000;

export default async function (req) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) {
    return Response.json(
      { status: "error", message: "Updater is not configured (missing token)." },
      { status: 500, headers: cors }
    );
  }

  const gh = (path, init) =>
    fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "accc-register-updater",
        ...(init && init.headers ? init.headers : {}),
      },
    });

  // Cooldown: skip if a run is queued/in-progress or finished very recently.
  try {
    const r = await gh(`/actions/workflows/${WORKFLOW}/runs?per_page=1`);
    if (r.ok) {
      const j = await r.json();
      const run = j.workflow_runs && j.workflow_runs[0];
      if (run) {
        if (run.status !== "completed") {
          return Response.json(
            {
              status: "already_running",
              message:
                "An update is already in progress — reload the page in a minute or two.",
            },
            { headers: cors }
          );
        }
        const age = Date.now() - new Date(run.updated_at).getTime();
        if (age < COOLDOWN_MS) {
          return Response.json(
            {
              status: "recent",
              message:
                "The register was just refreshed — reload the page to see the latest.",
            },
            { headers: cors }
          );
        }
      }
    }
  } catch (_) {
    // If the check fails, fall through and attempt the dispatch anyway.
  }

  const d = await gh(`/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main" }),
  });

  if (d.status === 204) {
    return Response.json(
      {
        status: "triggered",
        message:
          "Update started — it takes about 1–2 minutes. Reload the page shortly to see the latest data.",
      },
      { headers: cors }
    );
  }

  const detail = await d.text().catch(() => "");
  return Response.json(
    { status: "error", message: "Could not start the update. Please try again shortly.", detail },
    { status: 502, headers: cors }
  );
}
