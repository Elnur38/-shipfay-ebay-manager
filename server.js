const http = require("http");
const crypto = require("crypto");
const { URL, URLSearchParams } = require("url");

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.EBAY_CLIENT_ID || "";
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || "";
const RUNAME = process.env.EBAY_RUNAME || "";
const SCOPES = process.env.EBAY_SCOPES || [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment"
].join(" ");

const sessions = new Map();

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(v => {
    const i = v.indexOf("=");
    return [v.slice(0, i).trim(), decodeURIComponent(v.slice(i + 1))];
  }));
}

function session(req, res) {
  let id = cookies(req).shipfay_session;
  if (!id || !sessions.has(id)) {
    id = crypto.randomBytes(24).toString("hex");
    sessions.set(id, {});
    res.setHeader("Set-Cookie", `shipfay_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  }
  return sessions.get(id);
}

function send(res, status, body, type = "text/html; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

async function tokenRequest(params) {
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const response = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(params)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || "eBay token error");
  return data;
}

async function accessToken(s) {
  if (s.access_token && Date.now() < (s.expires_at || 0) - 60000) return s.access_token;
  if (!s.refresh_token) throw new Error("eBay hesabı qoşulmayıb");
  const data = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: s.refresh_token,
    scope: SCOPES
  });
  s.access_token = data.access_token;
  s.expires_at = Date.now() + data.expires_in * 1000;
  return s.access_token;
}

function page() {
  return `<!doctype html>
<html lang="az"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shipfay eBay Manager</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f7fb;color:#0f2340;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{background:#0b2344;color:#fff;padding:22px 18px;border-bottom:5px solid #e53935}
.wrap{max-width:980px;margin:auto}.brand{font-size:25px;font-weight:800}.sub{opacity:.8;margin-top:5px}
main{padding:22px 16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:15px}
.card{background:#fff;border:1px solid #dce3ec;border-radius:15px;padding:19px;box-shadow:0 5px 18px #102a4310}
h2{margin:0 0 9px;font-size:19px}.big{font-size:31px;font-weight:800;color:#1769e0}
button,a.btn{border:0;border-radius:11px;padding:13px 17px;font-weight:750;font-size:16px;cursor:pointer;text-decoration:none;display:inline-block}
.primary{background:#1769e0;color:#fff}.secondary{background:#eaf1fb;color:#0b2344}.danger{background:#fff0f0;color:#b92020}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.muted{color:#66778c}.ok{color:#168449;font-weight:750}.bad{color:#b92020;font-weight:750}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e5e9ef}th{color:#66778c}
.wide{grid-column:1/-1}.notice{background:#fff8e5;border:1px solid #f1d785;border-radius:10px;padding:12px;margin-top:14px}
@media(max-width:520px){table{display:block;overflow:auto}.brand{font-size:22px}}
</style></head>
<body><header><div class="wrap"><div class="brand">SHIPFAY — eBay Manager</div><div class="sub">Production inventory control</div></div></header>
<main class="wrap">
<div class="grid">
 <section class="card"><h2>eBay bağlantısı</h2><div id="status" class="muted">Yoxlanır…</div><div class="row" style="margin-top:15px"><a class="btn primary" href="/auth/ebay">eBay hesabını qoş</a><a class="btn danger" href="/auth/logout">Ayır</a></div></section>
 <section class="card"><h2>Məhsul sayı</h2><div class="big" id="count">—</div><div class="muted">Inventory API nəticəsi</div></section>
 <section class="card"><h2>Sistem</h2><div class="ok">● Online</div><div class="muted" style="margin-top:8px">Render web service</div></section>
 <section class="card wide"><div class="row" style="justify-content:space-between"><div><h2>eBay inventory</h2><div class="muted">Cari məhsulları eBay-dən oxuyur</div></div><button class="secondary" onclick="loadInventory()">Yenilə</button></div>
 <div id="message" class="notice">Əvvəl eBay hesabını qoşun.</div>
 <table><thead><tr><th>SKU</th><th>Başlıq</th><th>Miqdar</th><th>Vəziyyət</th></tr></thead><tbody id="items"></tbody></table>
 </section>
</div></main>
<script>
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function status(){
 const r=await fetch("/api/status"); const d=await r.json();
 document.getElementById("status").innerHTML=d.connected?'<span class="ok">● Qoşulub</span>':'<span class="bad">● Qoşulmayıb</span>';
 if(d.connected) loadInventory();
}
async function loadInventory(){
 const m=document.getElementById("message"), body=document.getElementById("items");
 m.textContent="Yüklənir…"; body.innerHTML="";
 try{
  const r=await fetch("/api/inventory"); const d=await r.json();
  if(!r.ok) throw new Error(d.error||"Xəta");
  const list=d.inventoryItems||[]; document.getElementById("count").textContent=list.length;
  m.textContent=list.length?list.length+" məhsul tapıldı.":"eBay inventory-də məhsul tapılmadı.";
  body.innerHTML=list.map(x=>'<tr><td>'+esc(x.sku)+'</td><td>'+esc(x.product&&x.product.title)+'</td><td>'+esc(x.availability&&x.availability.shipToLocationAvailability&&x.availability.shipToLocationAvailability.quantity||0)+'</td><td>'+esc(x.condition||"—")+'</td></tr>').join("");
 }catch(e){m.textContent=e.message;}
}
status();
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const s = session(req, res);
  try {
    if (url.pathname === "/") return send(res, 200, page());
    if (url.pathname === "/health") return json(res, 200, { ok: true });
    if (url.pathname === "/api/status") return json(res, 200, {
      connected: Boolean(s.refresh_token || s.access_token),
      configured: Boolean(CLIENT_ID && CLIENT_SECRET && RUNAME)
    });
    if (url.pathname === "/auth/ebay") {
      if (!CLIENT_ID || !CLIENT_SECRET || !RUNAME) {
        return send(res, 500, "Render Environment bölməsində EBAY_CLIENT_ID, EBAY_CLIENT_SECRET və EBAY_RUNAME əlavə edilməyib.");
      }
      s.oauth_state = crypto.randomBytes(20).toString("hex");
      const authUrl = new URL("https://auth.ebay.com/oauth2/authorize");
      authUrl.search = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: RUNAME,
        scope: SCOPES,
        state: s.oauth_state
      });
      res.writeHead(302, { Location: authUrl.toString() }); return res.end();
    }
    if (url.pathname === "/auth/ebay/callback") {
      if (url.searchParams.get("state") !== s.oauth_state) return send(res, 400, "OAuth state uyğun deyil.");
      const code = url.searchParams.get("code");
      if (!code) return send(res, 400, "eBay authorization code gəlmədi.");
      const data = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: RUNAME });
      s.access_token = data.access_token;
      s.refresh_token = data.refresh_token;
      s.expires_at = Date.now() + data.expires_in * 1000;
      res.writeHead(302, { Location: "/" }); return res.end();
    }
    if (url.pathname === "/auth/logout") {
      delete s.access_token; delete s.refresh_token; delete s.expires_at;
      res.writeHead(302, { Location: "/" }); return res.end();
    }
    if (url.pathname === "/api/inventory") {
      const token = await accessToken(s);
      const r = await fetch("https://api.ebay.com/sell/inventory/v1/inventory_item?limit=50", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
      });
      const data = await r.json();
      return json(res, r.status, r.ok ? data : { error: data.message || "eBay Inventory API xətası", details: data.errors });
    }
    return send(res, 404, "Not found");
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => console.log(`Shipfay eBay Manager port ${PORT}`));
