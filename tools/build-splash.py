import base64
from pathlib import Path

root = Path(r"D:\codingProject\MyDiary")
logo = (root / "electron" / "logo-256.png").read_bytes()
b64 = base64.b64encode(logo).decode("ascii")

html = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>MyDiary</title>
<style>
  :root { --bg:#0c1210; --accent:#2f8f78; --accent-soft:#6ec9b0; --ink:#e8f2ee; }
  * { box-sizing:border-box; margin:0; padding:0; }
  html,body { width:100%; height:100%; background:var(--bg); overflow:hidden; user-select:none; cursor:default; }
  body { display:grid; place-items:center; font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  .halo {
    position:absolute; width:280px; height:280px; border-radius:50%;
    background:radial-gradient(circle, rgba(47,143,120,0.28) 0%, rgba(47,143,120,0) 70%);
    opacity:0; transform:scale(0.6);
    animation:halo-in 1.1s cubic-bezier(0.22,1,0.36,1) 0.05s forwards, halo-out 0.9s cubic-bezier(0.4,0,0.2,1) 1.45s forwards;
  }
  .stage {
    position:relative; display:flex; flex-direction:column; align-items:center; gap:18px;
    opacity:0; transform:scale(0.82); filter:blur(6px);
    animation:logo-in 1s cubic-bezier(0.22,1,0.36,1) 0.15s forwards, logo-out 0.85s cubic-bezier(0.4,0,0.2,1) 1.55s forwards;
  }
  .logo-wrap {
    width:128px; height:128px; border-radius:28px; overflow:hidden;
    box-shadow:0 0 0 1px rgba(232,242,238,0.08), 0 18px 50px rgba(0,0,0,0.45), 0 0 40px rgba(47,143,120,0.25);
    background:rgba(232,242,238,0.04);
  }
  .logo-wrap img { width:100%; height:100%; object-fit:contain; display:block; padding:10px; }
  .wordmark {
    letter-spacing:0.28em; text-indent:0.28em; font-size:13px; font-weight:500; color:var(--ink);
    opacity:0; transform:translateY(8px);
    animation:text-in 0.7s cubic-bezier(0.22,1,0.36,1) 0.55s forwards, text-out 0.55s ease 1.55s forwards;
  }
  .wordmark span { color:var(--accent-soft); }
  .rail {
    width:120px; height:2px; border-radius:999px; background:rgba(232,242,238,0.08); overflow:hidden; opacity:0;
    animation:text-in 0.5s ease 0.75s forwards, text-out 0.4s ease 1.5s forwards;
  }
  .rail i {
    display:block; height:100%; width:40%; border-radius:inherit;
    background:linear-gradient(90deg, transparent, var(--accent-soft), transparent);
    transform:translateX(-120%); animation:sweep 1.1s cubic-bezier(0.4,0,0.2,1) 0.85s infinite;
  }
  @keyframes logo-in { to { opacity:1; transform:scale(1); filter:blur(0); } }
  @keyframes logo-out { to { opacity:0; transform:scale(1.12); filter:blur(8px); } }
  @keyframes halo-in { to { opacity:1; transform:scale(1); } }
  @keyframes halo-out { to { opacity:0; transform:scale(1.35); } }
  @keyframes text-in { to { opacity:1; transform:translateY(0); } }
  @keyframes text-out { to { opacity:0; transform:translateY(-6px); } }
  @keyframes sweep { to { transform:translateX(320%); } }
</style>
</head>
<body>
  <div class="halo"></div>
  <div class="stage">
    <div class="logo-wrap"><img src="data:image/png;base64,__LOGO__" alt="MyDiary" /></div>
    <div class="wordmark">My<span>Diary</span></div>
    <div class="rail"><i></i></div>
  </div>
</body>
</html>
"""

out = html.replace("__LOGO__", b64)
target = root / "electron" / "splash.html"
target.write_text(out, encoding="utf-8")
print("splash written", target.stat().st_size)
