# trialog.dev

Static files for the project's site. Deploy this folder as the site root (a file deploy, not the Next.js app). The live address, [trialog.dev](https://trialog.dev/), is updated only when the orchestrator says so, on an exact commit.

- `index.html` is the front page: the film, one sentence, «Try it in your browser», «Run your own», and the board.
- `try.html` is the interactive «How a message travels» page. A short redirect is left at [`docs/how-a-message-travels.html`](../how-a-message-travels.html).
- `journal-01.html` is the first journal post: what was built in the first two days, how the three work, and what went wrong. Each journal page links back to the front page.
- `robots.txt` lets every crawler in and names `sitemap.xml`, which lists every page. `llms.txt` is a short guide for AI agents ([llmstxt.org](https://llmstxt.org/)): what Trialog is and where the API, the client and the code are. Add a page, add it to the sitemap and to `llms.txt`. The hubs themselves stay out of search engines on purpose (`robots: noindex` in `app/layout.tsx`).
- Each page links the Trialog icon (`icon.svg`, plus a PNG and ICO so Safari shows it in the tab, and an Apple touch icon). The short redirect at the old path does too.
