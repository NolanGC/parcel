// The dashboard, in about two hundred lines of the platform.
//
// Both panes are sandboxed iframes carrying the same content policy the app
// uses for mail bodies (frontend/src/page/inbox/view.ts) — the "before" pane
// because it is showing a real untrusted email, and the "after" pane because
// it should be judged under identical conditions. If Zen's output only looks
// good with the app's stylesheet applied, that's the stylesheet's win.

const FRAME_CSP =
  "default-src 'none'; img-src data: blob: https: http:; style-src 'unsafe-inline'";

const FRAME_STYLE = `
  body{margin:16px;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       color:#1f2937;background:#fff;overflow-wrap:break-word}
  img{max-width:100%;height:auto}
  table{border-collapse:collapse}
  th,td{border:1px solid #d1d5db;padding:4px 8px;text-align:left}
  blockquote{margin:0 0 0 8px;padding-left:12px;border-left:3px solid #e5e7eb;color:#4b5563}
  pre{background:#f3f4f6;padding:10px;overflow:auto}
  details.quote{margin:10px 0;border-left:3px solid #e5e7eb;padding-left:12px}
  details.quote summary{cursor:pointer;color:#6b7280;font-size:12px;list-style:none}
  details.quote summary::-webkit-details-marker{display:none}
  details.quote summary::before{content:"···";letter-spacing:2px;
    background:#f3f4f6;border-radius:8px;padding:0 8px;margin-right:6px}
`;

const frame = (body) =>
  `<!doctype html><html><head><meta charset="utf-8">` +
  `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
  `<base target="_blank"><style>${FRAME_STYLE}</style></head><body>${body}</body></html>`;

const escapeHtml = (text) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
  );

const el = (id) => document.getElementById(id);
const state = {
  emails: [],
  selected: null,
  verdict: null,
  detail: null,
  searchTimer: undefined,
};

// LIST

const renderList = () => {
  el("list").replaceChildren(
    ...state.emails.map((email) => {
      const item = document.createElement("li");
      item.setAttribute(
        "aria-selected",
        String(email.messageId === state.selected),
      );
      item.dataset.id = email.messageId;

      const dot = document.createElement("span");
      dot.className = `dot ${email.verdict ?? ""} ${email.staleVerdict ? "stale" : ""}`;
      dot.title = email.verdict
        ? `${email.verdict}${email.staleVerdict ? " (older rules)" : ""}`
        : "not annotated";

      const subject = document.createElement("span");
      subject.className = "subject";
      subject.textContent = email.subject || "(no subject)";

      const from = document.createElement("span");
      from.className = "from";
      from.textContent = email.fromName || email.fromEmail;

      item.append(dot, subject, from);
      item.addEventListener("click", () => select(email.messageId));
      return item;
    }),
  );
};

const loadList = async () => {
  const query = encodeURIComponent(el("search").value);
  const response = await fetch(`/api/emails?limit=200&q=${query}`);
  const data = await response.json();
  state.emails = data.emails;
  el("build").textContent = `zen ${data.zenVersion}@${data.zenHash}`;
  renderList();
  if (state.selected === null && state.emails.length > 0) {
    select(state.emails[0].messageId);
  }
};

// DETAIL

const afterBody = (detail) => {
  if (detail.error !== undefined) {
    return `<pre style="color:#b91c1c">conversion failed\n\n${escapeHtml(detail.error)}</pre>`;
  }
  return detail.sections
    .map((section) =>
      section.kind === "fold"
        ? `<details class="quote ${section.foldKind}"><summary>${escapeHtml(section.summary)}</summary>${section.html}</details>`
        : section.html,
    )
    .join("");
};

const shrink = (detail) => {
  if (detail.bytes === undefined) return "";
  const ratio = detail.bytes.html / Math.max(1, detail.bytes.markdown);
  return `${(detail.bytes.markdown / 1024).toFixed(1)}kb · ${ratio.toFixed(1)}× smaller`;
};

const renderDetail = (detail) => {
  state.detail = detail;
  el("before").srcdoc = frame(detail.html);
  el("after").srcdoc = frame(afterBody(detail));
  el("source").textContent = detail.markdown ?? detail.error ?? "";
  el("before-meta").textContent = `${(detail.html.length / 1024).toFixed(1)}kb`;

  const meta = detail.meta;
  el("after-meta").textContent =
    detail.error !== undefined
      ? "failed"
      : `${shrink(detail)} · ${detail.ms.toFixed(0)}ms · ` +
        `${meta.quotes.length} quoted · ${meta.boilerplate.length} boilerplate · ` +
        `${meta.images.length} img · ${meta.links.length} links`;
};

const renderHistory = (records) => {
  el("history").replaceChildren(
    ...records.map((record) => {
      const item = document.createElement("li");
      item.innerHTML =
        `<code>${escapeHtml(record.zenHash)}</code> ` +
        `<strong>${escapeHtml(record.verdict)}</strong> ` +
        `${escapeHtml(record.note)} ` +
        `<em>${escapeHtml(record.at.slice(0, 16).replace("T", " "))}</em>`;
      return item;
    }),
  );
};

const select = async (messageId) => {
  state.selected = messageId;
  state.verdict = null;
  el("note").value = "";
  setVerdict(null);
  renderList();

  const [detail, history] = await Promise.all([
    fetch(`/api/email/${messageId}`).then((response) => response.json()),
    fetch(`/api/annotations?messageId=${messageId}`).then((response) =>
      response.json(),
    ),
  ]);
  if (state.selected !== messageId) return;
  renderDetail(detail);
  renderHistory(history);
};

// ANNOTATION

const setVerdict = (verdict) => {
  state.verdict = verdict;
  for (const button of el("verdicts").querySelectorAll("button")) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.verdict === verdict),
    );
  }
};

const save = async () => {
  if (state.selected === null || state.verdict === null) return;
  const response = await fetch("/api/annotations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messageId: state.selected,
      verdict: state.verdict,
      note: el("note").value,
    }),
  });
  const record = await response.json();

  const email = state.emails.find((item) => item.messageId === state.selected);
  if (email !== undefined) {
    email.verdict = record.verdict;
    email.staleVerdict = false;
    renderList();
  }
  el("note").value = "";
  setVerdict(null);
  renderHistory(
    await fetch(`/api/annotations?messageId=${state.selected}`).then((r) =>
      r.json(),
    ),
  );
};

// WIRING

el("verdicts").addEventListener("click", (event) => {
  const verdict = event.target.dataset?.verdict;
  if (verdict !== undefined) setVerdict(verdict);
});

el("save").addEventListener("click", save);

el("note").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save();
});

el("toggle-source").addEventListener("click", () => {
  const source = el("source");
  source.hidden = !source.hidden;
  el("after").hidden = !source.hidden;
});

el("search").addEventListener("input", () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(loadList, 200);
});

// j/k moves through the list, so a pass over fifty messages never needs the
// mouse. Skipped while typing a note, where they're letters.
document.addEventListener("keydown", (event) => {
  if (event.target.tagName === "TEXTAREA" || event.target.tagName === "INPUT")
    return;
  if (event.key !== "j" && event.key !== "k") return;
  const index = state.emails.findIndex(
    (item) => item.messageId === state.selected,
  );
  const next = index + (event.key === "j" ? 1 : -1);
  if (next >= 0 && next < state.emails.length) {
    select(state.emails[next].messageId);
    document.querySelector('#list li[aria-selected="true"]')?.scrollIntoView({
      block: "nearest",
    });
  }
});

loadList();
