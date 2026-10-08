# 从高清 glyph 源图生成 public/logo-mark.png（白色剪影 + alpha，裁剪到符号包围盒）
# 同时把 Pictures 里的原始素材重命名、并把母版拷贝进 electron/ 存档。
# 用法: python tools/make_mark.py
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

PICS = Path(r"C:\Users\LD\Pictures\dafen_icon")
ROOT = Path(r"D:\codingProject\MyDiary")

SRC_MASTER = PICS / "image_20261005D_134348_01.png"
SRC_ALT = PICS / "image_20261005D_134348_02.png"
NAME_MASTER = "df-glyph-1536-master.png"
NAME_ALT = "df-glyph-1536-alt.png"

# 1) 重命名原始素材（已在目标名时跳过）
for src, name in ((SRC_MASTER, NAME_MASTER), (SRC_ALT, NAME_ALT)):
    dst = PICS / name
    if src.exists() and not dst.exists():
        src.rename(dst)
        print("renamed:", src.name, "->", name)
    elif dst.exists():
        print("already named:", name)
    else:
        raise SystemExit(f"missing source: {src}")

master = PICS / NAME_MASTER

# 2) 母版存档进项目（electron/ 是图标源素材目录）
arch = ROOT / "electron" / "df-glyph-1536.png"
shutil.copyfile(master, arch)
print("archived:", arch)

# 3) 生成白色剪影：RGB 全白，alpha = 255 - 亮度（黑符号 -> 不透明，白底 -> 透明）
img = Image.open(master).convert("RGB")
arr = np.asarray(img).astype(np.float32)
lum = (0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2])
alpha = np.clip(255.0 - lum, 0, 255).astype(np.uint8)
# 轻阈值去噪：几乎透明的杂点归零，边缘保留抗锯齿
alpha[alpha < 8] = 0

sil = np.zeros((*alpha.shape, 4), dtype=np.uint8)
sil[..., 0:3] = 255
sil[..., 3] = alpha

# 4) 裁剪到符号包围盒 + 3% 呼吸边
ys, xs = np.where(alpha > 24)
y0, y1 = int(ys.min()), int(ys.max())
x0, x1 = int(xs.min()), int(xs.max())
h, w = alpha.shape
pad = int(round(max(y1 - y0, x1 - x0) * 0.03))
box = (max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + pad + 1), min(h, y1 + pad + 1))
out = Image.fromarray(sil, "RGBA").crop(box)

dst = ROOT / "public" / "logo-mark.png"
out.save(dst)
print("saved:", dst, out.size)
