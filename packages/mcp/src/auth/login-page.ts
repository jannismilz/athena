/** The password page shown to a browser during the OAuth connector flow. */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ESCAPES[c]!)
}

export function renderLoginPage(options: {
  instanceName: string
  sid: string
  redirectUri?: string | null
  error?: string
}): string {
  const name = escapeHtml(options.instanceName)
  const error = options.error
    ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
    : ''
  const consent = options.redirectUri
    ? `<p class="muted">After signing in you will be returned to
         <code>${escapeHtml(options.redirectUri)}</code>.</p>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to ${name}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfaf8; --fg: #1c1917; --muted: #78716c;
    --card: #ffffff; --border: #e7e5e4; --accent: #7c6f5a; --error: #b3261e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e;
      --card: #262322; --border: #3a3634; --accent: #c9bda6; --error: #f2b8b5;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 1.5rem; background: var(--bg); color: var(--fg);
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main {
    width: 100%; max-width: 24rem; background: var(--card);
    border: 1px solid var(--border); border-radius: 12px; padding: 2rem;
  }
  h1 { margin: 0 0 .25rem; font-size: 1.25rem; letter-spacing: -0.01em; }
  .muted { color: var(--muted); font-size: .875rem; margin: .25rem 0 1.25rem; }
  label { display: block; font-size: .875rem; font-weight: 600; margin-bottom: .375rem; }
  input, button {
    width: 100%; padding: .625rem .75rem; font: inherit; border-radius: 8px;
    border: 1px solid var(--border);
  }
  input { background: var(--bg); color: var(--fg); }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button {
    margin-top: 1rem; background: var(--accent); color: var(--bg);
    border-color: transparent; font-weight: 600; cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  .error {
    color: var(--error); font-size: .875rem; margin: 0 0 1rem;
    border-left: 3px solid var(--error); padding-left: .75rem;
  }
  code { word-break: break-all; font-size: .8125rem; }
</style>
</head>
<body>
<main>
  <h1>${name}</h1>
  <p class="muted">Sign in to give this AI client access to your wiki.</p>
  ${consent}${error}
  <form method="post" action="/login">
    <input type="hidden" name="sid" value="${escapeHtml(options.sid)}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password"
           autocomplete="current-password" autofocus required>
    <button type="submit">Connect</button>
  </form>
</main>
</body>
</html>
`
}
