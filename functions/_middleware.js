export async function onRequest(context) {
  const { request, env, next } = context;

  const auth = request.headers.get("Authorization") || "";
  const [scheme, encoded] = auth.split(" ");

  if (scheme === "Basic" && encoded) {
    const decoded = atob(encoded);
    const pass = decoded.slice(decoded.indexOf(":") + 1);
    if (pass === env.SITE_PASSWORD) {
      return next();
    }
  }

  return new Response("Please sign in to view this site.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Restricted", charset="UTF-8"',
    },
  });
}
