const invoke = window.__TAURI__?.core?.invoke;
const results = [];

function render(listId, items) {
  const ul = document.getElementById(listId);
  ul.innerHTML = "";
  for (const r of items) {
    const li = document.createElement("li");
    const icon = { pass: "✅", fail: "❌", info: "ℹ️", run: "⏳" }[r.status];
    li.innerHTML = `<span>${icon}</span><span></span><span class="detail"></span>`;
    li.children[1].textContent = r.name;
    li.children[2].textContent = r.detail || "";
    ul.appendChild(li);
  }
}

async function check(list, listId, name, fn) {
  const row = { name, status: "run", detail: "" };
  list.push(row);
  render(listId, list);
  try {
    const out = await fn();
    row.status = out?.status || "pass";
    row.detail = out?.detail ?? String(out ?? "");
  } catch (e) {
    row.status = "fail";
    row.detail = String(e?.message || e);
  }
  render(listId, list);
}

// Reachability without CORS: an opaque response means the server answered;
// a rejected promise means the network/proxy/firewall blocked it.
async function reach(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal: ctrl.signal });
    return { detail: `reached ${new URL(url).host}` };
  } catch (e) {
    throw new Error(`could not reach ${new URL(url).host} (${e.name === "AbortError" ? "timed out" : e.message}) — likely blocked by network/proxy`);
  } finally { clearTimeout(t); }
}

async function runAll() {
  results.length = 0;
  const L = "results";
  await check(results, L, "App launched", async () => ({ detail: new Date().toISOString() }));
  await check(results, L, "System info", async () => {
    if (!invoke) throw new Error("Tauri bridge missing");
    const s = await invoke("system_info");
    return { status: "info", detail: `${s.os}/${s.arch} — running from ${s.exe_path}` };
  });
  await check(results, L, "Web engine", async () => ({ status: "info", detail: navigator.userAgent }));
  await check(results, L, "Save a local file", () => invoke("storage_test"));
  await check(results, L, "OS keychain (for storing the GitHub token)", () => invoke("keychain_test"));
  await check(results, L, "GitHub API (api.github.com)", async () => {
    const res = await fetch("https://api.github.com/rate_limit", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return { detail: `OK — ${j.rate.remaining}/${j.rate.limit} anonymous calls left` };
  });
  await check(results, L, "Microsoft sign-in (login.microsoftonline.com)", () =>
    reach("https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration"));
  await check(results, L, "Microsoft Graph (graph.microsoft.com)", () =>
    reach("https://graph.microsoft.com/v1.0/$metadata"));
}

async function ghWrite() {
  const list = [];
  const L = "ghresults";
  const repo = document.getElementById("repo").value.trim();
  const token = document.getElementById("token").value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) {
    render(L, [{ name: "Enter repo as owner/name and a token", status: "fail" }]);
    return;
  }
  await check(list, L, `Write test file to ${repo}`, async () => {
    const info = invoke ? await invoke("system_info") : { os: "unknown" };
    const path = `phase0/${info.os}-${Date.now()}.json`;
    const body = JSON.stringify({ test: "phase0", os: info.os, at: new Date().toISOString() }, null, 2);
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ message: `Phase 0 test from ${info.os}`, content: btoa(body) }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${j.message || "unknown error"}`);
    return { detail: `created ${path}` };
  });
  document.getElementById("token").value = "";
  results.push(...list.map((r) => ({ ...r })));
}

function copyResults() {
  const text = results
    .map((r) => `${{ pass: "PASS", fail: "FAIL", info: "INFO", run: "…" }[r.status]} | ${r.name} | ${r.detail}`)
    .join("\n");
  navigator.clipboard.writeText(text || "No results yet — press Run checks first.")
    .then(() => { const b = document.getElementById("copy"); b.textContent = "Copied!"; setTimeout(() => (b.textContent = "Copy results"), 1500); });
}

document.getElementById("run").addEventListener("click", runAll);
document.getElementById("copy").addEventListener("click", copyResults);
document.getElementById("ghwrite").addEventListener("click", ghWrite);
runAll();
