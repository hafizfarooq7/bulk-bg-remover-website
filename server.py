# server.py
import sys
import os
import io
import numpy as np
from PIL import Image
from flask import Flask, request, send_file, render_template, jsonify
import torch

# --- FLASK APP ---
app = Flask(__name__, template_folder="templates", static_folder="static")

# --- ROOT ROUTE: serve HTML page ---
@app.route('/')
def index():
    return render_template('index.html')

# --- DEVICE ---
device = 'cuda' if torch.cuda.is_available() else 'cpu'
print("Using device:", device)

# --- ADD U2NET FOLDER TO PYTHONPATH ---
sys.path.append(os.path.join(os.path.dirname(__file__), "U2NET"))

# --- IMPORT MODEL ---
from model import U2NETP

# --- PATH TO PRETRAINED MODEL ---
U2NET_MODEL_PATH = os.path.join(os.path.dirname(__file__), "U2NET", "u2netp.pth")

# --- LOAD MODEL ---
model = U2NETP(3, 1)
model.load_state_dict(torch.load(U2NET_MODEL_PATH, map_location=device))
model.to(device)
model.eval()

# --- IMAGE TO TENSOR HELPER ---
def preprocess_image_pil(img: Image.Image):
    """Convert PIL image to torch tensor (C,H,W) normalized 0-1"""
    img = img.convert("RGB")
    img_np = np.array(img, dtype=np.float32) / 255.0
    img_tensor = torch.from_numpy(img_np).permute(2, 0, 1).unsqueeze(0)  # 1,C,H,W
    return img_tensor.to(device)

# --- PREDICT ALPHA ---
import torch.nn.functional as F
import numpy as np

def predict_alpha(img: Image.Image):
    input_tensor = preprocess_image_pil(img)

    with torch.no_grad():
        d1 = model(input_tensor)[0]              # U²-Net output
        pred = d1[:, 0, :, :]                    # main mask
        pred = torch.sigmoid(pred)

        # 🔒 NORMALIZE SAFELY (prevents full wipe)
        min_v = pred.min()
        max_v = pred.max()
        pred = (pred - min_v) / (max_v - min_v + 1e-8)

        # 🔁 resize to original image
        pred = F.interpolate(
            pred.unsqueeze(1),
            size=(img.height, img.width),
            mode="bilinear",
            align_corners=False
        ).squeeze()

    alpha = pred.cpu().numpy()

    # 🛡️ CRITICAL FIX — protect foreground
    alpha = np.clip(alpha, 0.05, 1.0)

    # 🧠 soft boost mid-confidence (hair, face)
    alpha = np.power(alpha, 0.9)

    return alpha



# --- REMOVE BACKGROUND ROUTE ---
@app.route('/remove-bg', methods=['POST'])
def remove_bg():
    if 'image' not in request.files:
        return "No image provided", 400

    file = request.files['image']
    img = Image.open(file).convert("RGB")
    orig_w, orig_h = img.size

    # --- preprocess ---
    img_resized = img.resize((320, 320))
    img_np = np.array(img_resized).astype(np.float32) / 255.0
    img_np = img_np.transpose(2, 0, 1)
    input_tensor = torch.from_numpy(img_np).unsqueeze(0).to(device)

    with torch.no_grad():
      
      d1 = model(input_tensor)[0]  # U²-Net output
    pred = torch.sigmoid(d1[:, 0, :, :])

    # Optional: mild foreground boost (protect weak areas)
    pred = torch.pow(pred, 0.95)  # gentle, not aggressive

    # Normalize safely
    pred = (pred - pred.min()) / (pred.max() - pred.min() + 1e-8)

    # Resize to image
    pred = F.interpolate(
        pred.unsqueeze(1),
        size=(img.height, img.width),
        mode="bilinear",
        align_corners=False
        ).squeeze()

    alpha = pred.cpu().numpy()

    # 🛡️ PROTECT FOREGROUND (THIS WAS MISSING)
    alpha[alpha < 0.03] = 0
    alpha = np.clip(alpha, 0, 1)
    alpha = np.power(alpha, 0.85)

    # --- compose RGBA ---
    img_np = np.array(img)
    alpha_8 = (alpha * 255).astype(np.uint8)
    result = np.dstack([img_np, alpha_8])

    result_img = Image.fromarray(result, "RGBA")

    buf = io.BytesIO()
    result_img.save(buf, format="PNG")
    buf.seek(0)

    return send_file(buf, mimetype="image/png")


# --- MAIN ---
if __name__ == '__main__':
    # Enables debug, hot reload, accessible externally
    app.run(debug=True, host='0.0.0.0', port=5000)
