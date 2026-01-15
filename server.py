# server.py
import sys
import os
import io
import numpy as np
from PIL import Image
from flask import Flask, request, send_file, render_template
import torch
import torch.nn.functional as F

# --- FLASK APP ---
app = Flask(__name__, template_folder="templates", static_folder="static")

# --- ROOT ROUTE ---
@app.route('/')
def index():
    return render_template('index.html')

# --- DEVICE ---
device = "cpu"  # 🔒 FORCE CPU (Render has no stable CUDA)
print("Using device:", device)

# --- ADD U2NET FOLDER ---
BASE_DIR = os.path.dirname(__file__)
sys.path.append(os.path.join(BASE_DIR, "U2NET"))

from model import U2NETP

U2NET_MODEL_PATH = os.path.join(BASE_DIR, "U2NET", "u2netp.pth")

# =========================
# 🔒 LOAD MODEL (SAFE)
# =========================
model = None

def load_model():
    global model
    if model is None:
        print("Loading U2NET model...")
        m = U2NETP(3, 1)
        state = torch.load(U2NET_MODEL_PATH, map_location="cpu")
        m.load_state_dict(state)
        m.eval()
        model = m
    return model

# =========================
# IMAGE PREPROCESS
# =========================
def preprocess_image(img: Image.Image, max_size=512):
    img = img.convert("RGB")

    # 🔒 HARD SIZE CAP (prevents OOM)
    w, h = img.size
    scale = min(max_size / max(w, h), 1.0)
    if scale < 1:
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    np_img = np.array(img).astype(np.float32) / 255.0
    tensor = torch.from_numpy(np_img).permute(2, 0, 1).unsqueeze(0)
    return img, tensor

# =========================
# REMOVE BG ROUTE
# =========================
@app.route('/remove-bg', methods=['POST'])
def remove_bg():
    if 'image' not in request.files:
        return "No image provided", 400

    file = request.files['image']
    img = Image.open(file)

    model = load_model()

    # --- preprocess ---
    img_proc, input_tensor = preprocess_image(img)

    with torch.no_grad():
        d1 = model(input_tensor)[0]
        pred = torch.sigmoid(d1[:, 0, :, :])

        # Normalize safely
        min_v, max_v = pred.min(), pred.max()
        pred = (pred - min_v) / (max_v - min_v + 1e-8)

        # Resize back
        pred = F.interpolate(
            pred.unsqueeze(1),
            size=(img_proc.height, img_proc.width),
            mode="bilinear",
            align_corners=False
        ).squeeze()

    alpha = pred.cpu().numpy()

    # 🛡️ FOREGROUND PROTECTION (your logic kept)
    alpha = np.clip(alpha, 0.03, 1.0)
    alpha = np.power(alpha, 0.85)

    # --- compose RGBA ---
    img_np = np.array(img_proc)
    alpha_8 = (alpha * 255).astype(np.uint8)
    result = np.dstack([img_np, alpha_8])

    out = Image.fromarray(result, "RGBA")

    buf = io.BytesIO()
    out.save(buf, format="PNG")
    buf.seek(0)

    return send_file(buf, mimetype="image/png")

# =========================
# MAIN (LOCAL ONLY)
# =========================
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
