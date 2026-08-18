/**
 * The password page.
 *
 * Shared by the MCP server, where it is the human approval step of the OAuth
 * connector flow, and by the dashboard, where it is a plain login. Both look
 * the same because they are the same page with different fields.
 */

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

export type LoginPageOptions = {
  instanceName: string
  /** Where the form posts to. */
  action: string
  /** One line under the heading saying what signing in gives access to. */
  purpose: string
  /** Rendered above the field, in red, when a previous attempt failed. */
  error?: string
  /** Rendered as muted text, for the OAuth consent line. */
  notice?: string
  /** Extra hidden inputs, such as the OAuth session id. */
  hidden?: Record<string, string>
  /** Shown under the button, for example a link back to the wiki. */
  footer?: string
}

export function renderLoginPage(options: LoginPageOptions): string {
  const name = escapeHtml(options.instanceName)
  const error = options.error
    ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
    : ''
  const notice = options.notice ? `<p class="muted">${options.notice}</p>` : ''
  const hidden = Object.entries(options.hidden ?? {})
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
    )
    .join('\n    ')
  const footer = options.footer ? `<p class="foot">${options.footer}</p>` : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in to ${name}</title>
<style>
  :root {
    color-scheme: light;
    --paper: #f3f4f1; --raised: #fbfbfa; --sunken: #eaece7;
    --ink: #141715; --ink-2: #565d58; --ink-3: #858c86;
    --rule: #d9dcd6; --rule-firm: #c2c7bf;
    --accent: #146b5c; --accent-ink: #0e5348; --on-accent: #fbfbfa;
    --error: #b3261e;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --paper: #101210; --raised: #181b19; --sunken: #0a0c0a;
      --ink: #e9ece8; --ink-2: #a3ada6; --ink-3: #6f7a73;
      --rule: #262a27; --rule-firm: #363c38;
      --accent: #45a894; --accent-ink: #63c0ad; --on-accent: #071009;
      --error: #f2b8b5;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 1.5rem; background: var(--paper); color: var(--ink);
    font: 16px/1.6 ui-serif, "Iowan Old Style", Charter, Georgia, serif;
  }
  main {
    width: 100%; max-width: 23rem; background: var(--raised);
    border: 1px solid var(--rule-firm); border-radius: 4px; padding: 1.75rem;
  }
  h1 {
    margin: 0 0 .35rem; font-size: 1.0625rem; font-weight: 600;
    letter-spacing: .12em; text-transform: uppercase;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    display: flex; align-items: center; gap: .5rem;
  }
  .muted { color: var(--ink-2); font-size: .8125rem; margin: 0 0 1.25rem; }
  label {
    display: block; font-size: .6875rem; letter-spacing: .1em;
    text-transform: uppercase; color: var(--ink-3); margin-bottom: .4rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  input {
    width: 100%; padding: .6rem .7rem; font: inherit; font-size: .9375rem;
    border: 1px solid var(--rule-firm); border-radius: 3px;
    background: var(--paper); color: var(--ink);
  }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button {
    width: 100%; margin-top: 1rem; padding: .6rem .7rem; cursor: pointer;
    border: 1px solid transparent; border-radius: 3px;
    background: var(--accent); color: var(--on-accent); font-weight: 600;
    font-size: .8125rem; letter-spacing: .02em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  button:hover { background: var(--accent-ink); }
  .error {
    color: var(--error); font-size: .8125rem; margin: 0 0 1rem;
    border-left: 2px solid var(--error); padding-left: .7rem;
  }
  .foot { margin: 1.25rem 0 0; font-size: .75rem; color: var(--ink-3); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8125rem; word-break: break-all; }
  a { color: var(--accent-ink); }
</style>
</head>
<body>
<main>
  <h1><span aria-hidden="true">&#129417;</span> ${name}</h1>
  <p class="muted">${escapeHtml(options.purpose)}</p>
  ${notice}${error}
  <form method="post" action="${escapeHtml(options.action)}">
    ${hidden}
    <label for="password">Password</label>
    <input id="password" name="password" type="password"
           autocomplete="current-password" autofocus required>
    <button type="submit">Sign in</button>
  </form>
  ${footer}
</main>
</body>
</html>
`
}
