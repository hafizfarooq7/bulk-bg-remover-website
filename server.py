# server.py
import sys
import os
import io
import numpy as np
from PIL import Image
from flask import Flask, request, send_file, render_template
import torch

# =============================
# 🔒 RENDER STABILITY FIXES (NEW)
# =============================
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
torch.set_num_threads(1)
torch.set_num_interop_threads(1)

# --- FLASK APP ---
app = Flask(__name__, template_folder="templates", static_folder="static")

# --- ROOT ROUTE ---
@app.route('/')
def index():
    return render_template('index.html')

# =============================
# 🔒 FORCE CPU (CRITICAL)
# =============================
device = "cpu"
print("Using device:", device)

# --- ADD U2NET FOLDER ---
sys.path.append(os.path.join(os.path.dirname(__file__), "U2NET"))

# --- IMPORT MODEL ---
from model import U2NETP
import torch.nn.functional as F

# --- MODEL PATH ---
U2NET_MODEL_PATH = os.path.join(os.path.dirname(__file__), "U2NET", "u2netp.pth")

# --- LOAD MODEL (UNCHANGED LOGIC) ---
model = U2NETP(3, 1)
model.load_state_dict(torch.load(U2NET_MODEL_PATH, map_location=device))
model.to(device)
model.eval()

# --- PREPROCESS (UNCHANGED) ---
def preprocess_image_pil(img: Image.Image):
    img = img.convert("RGB")
    img_np = np.array(img, dtype=np.float32) / 255.0
    img_tensor = torch.from_numpy(img_np).permute(2, 0, 1).unsqueeze(0)
    return img_tensor.to(device)

# --- REMOVE BACKGROUND ROUTE ---
@app.route('/remove-bg', methods=['POST'])
def remove_bg():
    if 'image' not in request.files:
        return "No image provided", 400

    file = request.files['image']
    img = Image.open(file).convert("RGB")

    # --- ORIGINAL PREPROCESS (UNCHANGED) ---
    img_resized = img.resize((320, 320))
    img_np = np.array(img_resized).astype(np.float32) / 255.0
    img_np = img_np.transpose(2, 0, 1)
    input_tensor = torch.from_numpy(img_np).unsqueeze(0).to(device)

    with torch.no_grad():
        d1 = model(input_tensor)[0]

    pred = torch.sigmoid(d1[:, 0, :, :])

    # 🔑 SAME QUALITY LOGIC
    pred = torch.pow(pred, 0.95)
    pred = (pred - pred.min()) / (pred.max() - pred.min() + 1e-8)

    pred = F.interpolate(
        pred.unsqueeze(1),
        size=(img.height, img.width),
        mode="bilinear",
        align_corners=False
    ).squeeze()

    alpha = pred.cpu().numpy()

    # 🔑 SAME FOREGROUND PROTECTION
    alpha[alpha < 0.03] = 0
    alpha = np.clip(alpha, 0, 1)
    alpha = np.power(alpha, 0.85)

    # --- COMPOSE RGBA ---
    img_np = np.array(img)
    alpha_8 = (alpha * 255).astype(np.uint8)
    result = np.dstack([img_np, alpha_8])

    result_img = Image.fromarray(result, "RGBA")

    buf = io.BytesIO()
    result_img.save(buf, format="PNG")
    buf.seek(0)

    return send_file(buf, mimetype="image/png")


# --- MAIN ---
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
